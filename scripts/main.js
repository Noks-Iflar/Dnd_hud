/**
 * HUD Хвора — основной скрипт модуля.
 * Левый блок — сфера ПЗ, портрет, характеристики, режим броска, отдых.
 * Центральный блок — способности, сгруппированные по типу действия.
 */

const MODULE_ID = "khvor-hud";
const ASSETS = `modules/${MODULE_ID}/assets`;
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Чей HUD показывать.
 * Выделен ровно один токен — его. Ничего не выделено: игроку — его персонажа, ГМу — ничего.
 */
function findActor() {
  const controlled = canvas?.tokens?.controlled ?? [];
  if (controlled.length === 1 && controlled[0].actor) return controlled[0].actor;
  if (!game.user.isGM && game.user.character) return game.user.character;
  return null;
}

/** Число со знаком: 3 → «+3», −2 → «−2». */
const signed = (n) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

/** Единицы движения из dnd5e в русские сокращения. */
const UNITS = { ft: "фт", m: "м", mi: "миль", km: "км" };

/**
 * Группы панели способностей в порядке показа.
 * key — тип активации dnd5e (activity.activation.type), «items» — расходники (зелья, свитки).
 */
const GROUPS = [
  { key: "action", label: "Действие", gem: "gem-action" },
  { key: "bonus", label: "Бонусное", gem: "gem-bonus" },
  { key: "reaction", label: "Реакция", gem: "gem-reaction" },
  { key: "legendary", label: "Легендарные", gem: null },
  { key: "special", label: "Особые", gem: null },
  { key: "items", label: "Предметы", gem: null }
];

/** Круги заклинаний римскими цифрами, как на макете. */
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];

/**
 * Базовые действия из правил 2024 года, мини-сетка в группе «Действие».
 * status — id состояния Foundry, которое включается кнопкой, если такое состояние есть в мире.
 * skill — навык, проверка которого бросается сразу.
 */
const BASIC_ACTIONS = [
  { id: "dash", label: "Рывок", icon: "icon-dash",
    rule: "До конца хода скорость увеличивается на значение текущей скорости." },
  { id: "disengage", label: "Отход", icon: "icon-disengage",
    rule: "До конца хода перемещение не провоцирует атаки." },
  { id: "dodge", label: "Уклонение", icon: "icon-dodge", status: "dodging",
    rule: "До начала следующего хода атаки по вам с помехой, спасброски Ловкости с преимуществом. Пропадает, если вы недееспособны или ваша скорость 0." },
  { id: "help", label: "Помощь", icon: "icon-help",
    rule: "Помощь союзнику в проверке характеристики или атаке по существу рядом с вами: следующий такой бросок союзника — с преимуществом." },
  { id: "hide", label: "Засада", icon: "icon-hide", skill: "ste",
    rule: "Проверка Ловкости (Скрытность) СЛ 15, нужно быть вне поля зрения врагов. При успехе вы невидимы, пока не выдадите себя." },
  { id: "ready", label: "Подготовка", icon: "icon-ready",
    rule: "Выберите действие и условие. Когда условие наступит до вашего следующего хода, выполните действие реакцией." }
];

/** Вкладки-фильтры над панелью. «Все» есть всегда, остальные — только если в них что-то есть. */
const TABS = [
  { id: "all", label: "Все" },
  { id: "attacks", label: "Атаки" },
  { id: "spells", label: "Заклинания" },
  { id: "features", label: "Умения" },
  { id: "items", label: "Предметы" }
];

/**
 * Сколько столбцов плиток помещается на странице панели. Считаем от свободной ширины:
 * от левого края окна до боковой панели Foundry (чат и вкладки), минус левый блок HUD
 * и запас под будущий правый блок (инвентарь, лист, «Завершить ход»).
 */
const TILE_WIDTH = 64;        // плитка 60 px + промежуток
const LEFT_BLOCK_WIDTH = 640; // портрет, сфера и левая панель
const RIGHT_RESERVE = 220;    // будущий правый блок
const PANEL_EXTRAS = 160;     // рамка панели, разделители групп, отступы
const COLUMNS_MIN = 5;
const COLUMNS_MAX = 12;

/** Правая граница свободной области: левый край боковой панели Foundry (или край окна). */
function freeAreaRight() {
  const sidebar = document.getElementById("sidebar");
  const left = sidebar?.getBoundingClientRect().left;
  return left > 0 ? left : window.innerWidth;
}

function pageColumns() {
  const free = freeAreaRight() - LEFT_BLOCK_WIDTH - RIGHT_RESERVE - PANEL_EXTRAS;
  return Math.clamp(Math.floor(free / TILE_WIDTH), COLUMNS_MIN, COLUMNS_MAX);
}

/** К какой вкладке относится плитка. */
function tileCategory(item, activity) {
  if (["consumable", "tool", "equipment", "loot"].includes(item.type)) return "items";
  if (item.type === "spell" || activity.type === "cast") return "spells";
  if (item.type === "weapon" || activity.type === "attack") return "attacks";
  return "features";
}

/**
 * Готовит панель к показу: оставляет плитки выбранной вкладки и режет их на страницы.
 * На странице rows × columns плиток (columns — от ширины экрана, см. pageColumns()); группы, которые не попали на страницу, скрываются.
 * Возвращает группы страницы, вкладки и номер страницы.
 */
function paginate(groups, { tab, page, rows, columns = COLUMNS_MAX }) {
  const tabs = TABS.filter((t) => t.id === "all" || groups.some((g) => g.tiles.some((x) => x.category === t.id)));
  if (!tabs.some((t) => t.id === tab)) tab = "all";

  // Все плитки вкладки подряд, каждая помнит свою группу.
  const flat = groups.flatMap((g) => g.tiles.filter((x) => tab === "all" || x.category === tab).map((x) => [g, x]));
  const perPage = rows * columns;
  const pages = Math.max(1, Math.ceil(flat.length / perPage));
  page = Math.clamp(page, 0, pages - 1);

  const shown = new Map();
  for (const [g, x] of flat.slice(page * perPage, (page + 1) * perPage)) {
    if (!shown.has(g.key)) shown.set(g.key, { ...g, tiles: [] });
    shown.get(g.key).tiles.push(x);
  }
  const pageGroups = [...shown.values()];
  // В режиме двух строк у группы половина столбцов: плитки идут слева направо, потом вторая строка.
  for (const g of pageGroups) g.cols = Math.max(1, Math.ceil(g.tiles.length / rows));

  return {
    groups: pageGroups,
    tabs: tabs.map((t) => ({ ...t, active: t.id === tab })),
    tab,
    page,
    pages,
    pageLabel: `${page + 1}/${pages}`,
    multi: pages > 1,
    hasPrev: page > 0,
    hasNext: page < pages - 1,
    tall: rows === 2
  };
}

/** «Раздирание [Rend]» → «Раздирание»: английское название в квадратных скобках не нужно. */
const ruName = (name) => (name ?? "").replace(/\s*\[[^\]]*\]\s*$/, "").trim();

/** Подпись на плитке короче: «Рассеивание магии (2/день)» → «Рассеивание магии». */
const tileName = (name) => name.replace(/\s*\([^)]*\)\s*$/, "").trim();

/** Стандартные значки dnd5e (например, силуэт монстра) хуже картинки самого предмета. */
const isGenericIcon = (img) => !img || img.startsWith("systems/dnd5e/icons/svg/");

/**
 * Сколько использований осталось. В выгрузке max — строка-формула («2»), а у готового
 * предмета в Foundry уже число; остаток считаем сами как max − spent.
 * Возвращает null, если у способности нет ограничения.
 */
function usesLeft(uses) {
  const max = Number(uses?.max);
  if (!Number.isFinite(max) || max <= 0) return null;
  return { value: Math.max(0, max - (uses.spent ?? 0)), max };
}

/**
 * В какую группу панели попадает активность; null — никуда.
 * Расходники — в «Предметы», остальное — по типу активации.
 * «Особое» (например, «Порыв к действию») показываем, только если у способности есть заряды:
 * так в панель не попадают пассивки вроде «Ловкого маневрирования». Легендарное сопротивление
 * NPC тоже «особое», но ему место в левом блоке (шаг 8 плана).
 */
function groupOf(item, activity) {
  if (item.type === "consumable") return "items";
  const type = activity.activation?.type;
  if (type === "special") {
    const legres = activity.consumption?.targets?.some((t) => t.target === "resources.legres.value");
    return !legres && (usesLeft(item.system.uses) || usesLeft(activity.uses)) ? "special" : null;
  }
  if (type === "items") return null;
  return GROUPS.some((g) => g.key === type) ? type : null;
}

/**
 * Имя плитки (полное, для подсказки) и подпись (короткая, на плитке).
 * - «forward» — бесплатное сотворение заклинания 1 раз в день: «Тьма (своб.)».
 * - Если у предмета несколько активностей в одной группе («Хитроумное действие»: Рывок,
 *   Отступление, Засада; «Заклинания» дракона), подписываем именем активности.
 * - Иначе — имя предмета.
 */
function displayName(item, activity) {
  const base = ruName(item.name);
  if (activity.type === "forward") return { name: `${base} (свободное сотворение)`, label: `${tileName(base)} (своб.)` };
  const group = groupOf(item, activity);
  const siblings = [...item.system.activities].filter((a) => a.type !== "forward" && groupOf(item, a) === group).length;
  const own = ruName(activity.name ?? "");
  const name = own && siblings > 1 ? own : base;
  return { name, label: tileName(name) };
}

/**
 * Есть ли у актёра ячейка, чтобы сотворить заклинание круга level.
 * Обычные заклинания можно творить и ячейкой договора, заклинания договора — только ею.
 * Остаток ячеек — spells.spellN.value / spells.pact.value (так же их читает макрос снимка Dnd Hub).
 */
function hasSlot(actor, level, method) {
  const spells = actor.system.spells ?? {};
  const pact = spells.pact;
  const pactOk = (pact?.value ?? 0) > 0 && (pact?.level ?? 0) >= level;
  if (method === "pact") return pactOk;
  for (let l = level; l <= 9; l++) if ((spells[`spell${l}`]?.value ?? 0) > 0) return true;
  return pactOk;
}

/**
 * Ячейки заклинаний над панелью: ряд ромбов на каждый круг, где есть ячейки, и отдельно договор.
 * gems — массив true/false: горит или потрачена.
 */
function spellSlots(actor) {
  const spells = actor.system.spells ?? {};
  const gems = (value, max) => Array.from({ length: max }, (_, i) => i < (value ?? 0));
  const rows = [];
  for (let l = 1; l <= 9; l++) {
    const max = Number(spells[`spell${l}`]?.max) || 0;
    if (max > 0) rows.push({ label: ROMAN[l], title: `Ячейки ${l} круга`, gems: gems(spells[`spell${l}`].value, max) });
  }
  const pact = spells.pact;
  const pactMax = Number(pact?.max) || 0;
  if (pactMax > 0) {
    rows.push({ label: "Договор", title: `Ячейки договора (${pact.level} круг)`, gems: gems(pact.value, pactMax), pact: true });
  }
  return rows;
}

/**
 * Значки и состояние плитки:
 * - заряды «2/3» (сначала у самой активности, как «Огненный шар» 1/день, потом у предмета);
 * - перезарядка «5–6» (recovery с period "recharge" и порогом в formula);
 * - количество «×3» у расходников;
 * - цена легендарного действия ромбами;
 * - spent — плитка бледнеет: заряды кончились или не хватает легендарных действий.
 */
function tileState(actor, item, activity, groupKey) {
  // Заряды предмета у заклинания относятся только к бесплатному сотворению (активность их тратит),
  // а обычное сотворение идёт ячейкой.
  const consumesItem = activity.consumption?.targets?.some((t) => t.type === "itemUses");
  const itemUses = item.type === "spell" && !consumesItem ? null : usesLeft(item.system.uses);
  let uses = usesLeft(activity.uses) ?? itemUses;
  // Одноразовый расходник (зелье, огонь): «1/1» ничего не говорит, важно только количество «×2».
  if (item.type === "consumable" && uses?.max === 1 && !usesLeft(activity.uses)) uses = null;
  const recharge = item.system.uses?.recovery?.find((r) => r.period === "recharge");
  const state = { badge: null, cost: null, spent: false };

  if (recharge) {
    const from = Number(recharge.formula) || 6;
    state.badge = from >= 6 ? "6" : `${from}–6`;
    state.recharge = true;
  } else if (uses) {
    state.badge = `${uses.value}/${uses.max}`;
  }
  if (uses && uses.value === 0) state.spent = true;

  // Заклинание за ячейку: значок круга «III», плитка бледнеет, если подходящих ячеек не осталось.
  const level = item.type === "spell" ? item.system.level ?? 0 : 0;
  if (level > 0 && activity.type !== "forward" && !consumesItem && !uses) {
    state.badge = ROMAN[level];
    state.level = true;
    state.pact = item.system.method === "pact";
    if (!hasSlot(actor, level, item.system.method)) state.spent = true;
  }

  if (item.type === "consumable" && (item.system.quantity ?? 1) > 1) state.quantity = `×${item.system.quantity}`;

  if (groupKey === "legendary") {
    const cost = activity.activation?.value || 1;
    const legact = actor.system.resources?.legact;
    const left = (legact?.max ?? 0) - (legact?.spent ?? 0);
    state.cost = Array.from({ length: cost });
    if (cost > left) state.spent = true;
  }
  return state;
}

/**
 * Собирает способности актёра в группы по типу действия.
 * Одна плитка — одна активность предмета (у «Заклинаний» дракона их четыре).
 * Пустые группы не возвращаются, так что пустых ячеек в HUD не будет.
 */
function collectAbilities(actor) {
  const items = [...actor.items].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  // Заклинания, которые активность «cast» создаёт сама. В флаге cachedFor — путь к этой активности,
  // например ".Item.mmSpellcasting00.Activity.NYI0XAuSZOULfXoN". Такие копии отдельно не показываем,
  // но берём у них картинку для плитки.
  const cachedSpells = new Map();
  for (const item of items) {
    const cachedFor = item.getFlag("dnd5e", "cachedFor");
    if (cachedFor) cachedSpells.set(cachedFor, item);
  }

  const groups = Object.fromEntries(GROUPS.map((g) => [g.key, []]));

  // Есть ли у актёра хоть какие-то ячейки. Если нет (плут, воин), обычное сотворение заклинания
  // бесполезно — оставляем только бесплатное («своб.»), как «Скороход» Муарена.
  const spells = actor.system.spells ?? {};
  const anySlots = Object.values(spells).some((sl) => (Number(sl?.max) || 0) > 0);

  for (const item of items) {
    if (item.getFlag("dnd5e", "cachedFor")) continue;
    // Заклинания — только подготовленные: prepared 1 — подготовлено, 2 — всегда, 0 — нет.
    if (item.type === "spell" && !(item.system.prepared >= 1)) continue;
    // Оружие и снаряжение — только надетое; инструменты в бою не нужны.
    if (["weapon", "equipment"].includes(item.type) && !item.system.equipped) continue;
    if (item.type === "tool") continue;

    const activities = item.system.activities;
    if (!activities?.size) continue; // пассивные черты без действий

    // Коллекция Foundry при for...of отдаёт значения, а не пары.
    for (const activity of activities) {
      const groupKey = groupOf(item, activity);
      if (!groupKey) continue; // «минута», «час», без активации и т. п. в панель не попадают
      const needsSlot = item.type === "spell" && (item.system.level ?? 0) > 0 && activity.type !== "forward"
        && !activity.consumption?.targets?.some((t) => t.type === "itemUses");
      if (needsSlot && !anySlots && !usesLeft(activity.uses)) continue;

      const spell = activity.type === "cast" ? cachedSpells.get(`.Item.${item.id}.Activity.${activity.id}`) : null;
      const img = spell?.img ?? (isGenericIcon(activity.img) ? item.img : activity.img);
      const { name, label } = displayName(item, activity);

      groups[groupKey].push({
        itemId: item.id, activityId: activity.id, name, label, img,
        category: tileCategory(item, activity),
        ...tileState(actor, item, activity, groupKey)
      });
    }
  }

  return GROUPS
    .map((g) => ({ ...g, tiles: groups[g.key] }))
    .filter((g) => g.tiles.length > 0);
}

/* ---------- Полоска движения (как в BG3) ---------- */

/** Сколько всего делений в полоске: одно деление — 5 фт, но не больше 12 (у летунов 80 фт). */
const MOVE_SEGMENTS_MAX = 12;

/**
 * Остаток движения в этот ход. Считаем только в начатом бою и только для токена-участника:
 * пройденное — длина пути из истории перемещений токена (TokenDocument#movementHistory, V13+),
 * измеренная по сетке сцены. Вне боя полоска полная.
 * tracked = false — истории нет или не в бою, показываем просто скорость.
 */
function movement_(actor, speed) {
  const total = Number(speed) || 0;
  const full = (n) => Array.from({ length: n }, () => true);
  const count = Math.min(MOVE_SEGMENTS_MAX, Math.max(1, Math.round(total / 5)));
  const result = { total, left: total, tracked: false, segments: full(count) };

  const token = actor.token ?? actor.getActiveTokens?.(false, true)?.[0];
  const combat = game.combat;
  const inCombat = combat?.started && token && combat.combatants.some((c) => c.tokenId === token.id);
  const history = token?.movementHistory;
  if (!inCombat || !Array.isArray(history)) return result;

  let used = 0;
  if (history.length > 1) used = canvas.grid.measurePath(history).distance ?? 0;
  const left = Math.max(0, Math.round(total - used));
  const lit = total > 0 ? Math.round((left / total) * count) : 0;
  return { total, left, tracked: true, segments: Array.from({ length: count }, (_, i) => i < lit) };
}

/* ---------- Подсказка способности ---------- */

/** Вид способности для второй строки подсказки. */
function abilityKind(item, spell) {
  const asSpell = spell ?? (item.type === "spell" ? item : null);
  if (asSpell) return asSpell.system.level ? `${asSpell.system.level} круг` : "Заговор";
  return { weapon: "Оружие", feat: "Умение", consumable: "Расходник", equipment: "Снаряжение", tool: "Инструмент" }[item.type] ?? "";
}

/** Название характеристики по-русски из конфигурации dnd5e (её переводит модуль локализации). */
const abilityLabel = (key) => CONFIG.DND5E?.abilities?.[key]?.label ?? key;
const damageLabel = (key) => (CONFIG.DND5E?.damageTypes?.[key]?.label ?? key ?? "").toLowerCase();

/**
 * Данные компактной подсказки: имя, «вид · тип действия · дальность» и строка с атакой,
 * испытанием и уроном. Для активности «cast» берём сотворяемое заклинание: у него свои
 * атака, урон и описание.
 * Подписи dnd5e (labels.toHit «+8», labels.damages [{ formula, damageType }], labels.range) —
 * те же, что приложение Dnd Hub читает из снимков.
 */
function abilityTip(actor, itemId, activityId) {
  const item = actor.items.get(itemId);
  const activity = item?.system.activities?.get(activityId);
  if (!activity) return null;

  const spell = activity.type === "cast"
    ? actor.items.find((i) => i.getFlag("dnd5e", "cachedFor") === `.Item.${item.id}.Activity.${activity.id}`)
    : null;
  // Атака и урон — у активности самого заклинания, если оно есть; у «forward» — у той активности,
  // которую он запускает (activity.activity.id).
  const forwarded = activity.type === "forward" ? item.system.activities.get(activity.activity?.id) : null;
  const act = (spell && [...(spell.system.activities ?? [])][0]) || forwarded || activity;
  const labels = act.labels ?? {};

  const group = GROUPS.find((g) => g.key === groupOf(item, activity));
  const sub = [abilityKind(item, spell), group?.label, labels.range].filter(Boolean).join(" · ");

  const stats = [];
  if (labels.toHit) stats.push({ label: "Атака", value: labels.toHit });
  const dc = act.save?.dc?.value;
  if (dc) {
    const ability = [...(act.save.ability ?? [])][0];
    stats.push({ label: ability ? `Испытание ${abilityLabel(ability)}` : "Испытание", value: `СЛ ${dc}` });
  }
  const damages = (labels.damages ?? []).filter((d) => d.formula);
  if (damages.length) {
    stats.push({ label: "Урон", value: damages.map((d) => `${d.formula} ${damageLabel(d.damageType)}`.trim()).join(" + ") });
  }

  return {
    name: displayName(item, activity).name,
    sub,
    stats,
    // Описание берём у заклинания, если это «cast», иначе у самого предмета.
    source: spell ?? item
  };
}

/** Описание предмета в HTML Foundry: [[lookup @name]], ссылки и броски превращаются в текст. */
async function enrichedDescription(item) {
  const html = item.system.description?.value ?? "";
  if (!html) return "<p><em>Описания нет.</em></p>";
  const TextEditor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  return TextEditor.enrichHTML(html, { rollData: item.getRollData?.(), relativeTo: item, secrets: item.isOwner });
}

class KhvorHud extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "khvor-hud",
    tag: "section",
    classes: ["khvor-hud"],
    // Без рамки окна и без автоматического позиционирования: HUD сам стоит внизу экрана.
    window: { frame: false, positioned: false },
    // Кнопки в шаблоне с data-action="..." вызывают эти функции.
    actions: {
      openSheet: KhvorHud.#openSheet,
      rollInitiative: KhvorHud.#rollInitiative,
      openSkills: KhvorHud.#openSkills,
      setRollMode: KhvorHud.#setRollMode,
      useAbility: KhvorHud.#useAbility,
      basicAction: KhvorHud.#basicAction,
      toggleInspiration: KhvorHud.#toggleInspiration,
      rollDeathSave: KhvorHud.#rollDeathSave,
      setTab: KhvorHud.#setTab,
      prevPage: KhvorHud.#prevPage,
      nextPage: KhvorHud.#nextPage,
      toggleRows: KhvorHud.#toggleRows,
      shortRest: KhvorHud.#shortRest,
      longRest: KhvorHud.#longRest
    }
  };

  static PARTS = {
    hud: { template: `modules/${MODULE_ID}/templates/hud.hbs` }
  };

  /** Актёр, которого сейчас показывает HUD. */
  actor = null;

  /** Выбранная вкладка и страница панели способностей; сбрасываются при смене актёра. */
  panel = { actorId: null, tab: "all", page: 0 };

  /** Собирает данные для шаблона. */
  async _prepareContext() {
    this.actor = findActor();
    document.body.classList.toggle("khvor-hud-active", !!this.actor);
    const actor = this.actor;
    if (!actor) return { actor: false };

    const sys = actor.system;
    const attr = sys.attributes ?? {};

    if (this.panel.actorId !== actor.id) this.panel = { actorId: actor.id, tab: "all", page: 0 };
    const abilities = paginate(collectAbilities(actor), {
      tab: this.panel.tab,
      page: this.panel.page,
      rows: game.settings.get(MODULE_ID, "tallPanel") ? 2 : 1,
      columns: pageColumns()
    });
    // Запоминаем то, что реально показали: вкладка могла исчезнуть, страниц могло стать меньше.
    this.panel.tab = abilities.tab;
    this.panel.page = abilities.page;

    const hp = attr.hp ?? {};
    const max = hp.effectiveMax ?? hp.max ?? 0;
    const value = hp.value ?? 0;
    const pct = max > 0 ? Math.clamp(value / max, 0, 1) : 0;

    const movement = attr.movement ?? {};
    const spellDC = attr.spellcasting ? attr.spell?.dc : null;
    const rollMode = game.settings.get(MODULE_ID, "rollMode");

    // Хвор: статус с id «khvor» или любой активный эффект, в названии которого есть «Хвор».
    const khvor = actor.statuses?.has("khvor")
      || (actor.appliedEffects ?? actor.effects).some((e) => e.name?.includes("Хвор"));

    return {
      actor: true,
      assets: ASSETS,
      name: actor.name,
      img: actor.img,
      khvor,
      hp: {
        value,
        max,
        temp: hp.temp || 0,
        // Какая доля сферы пустая, в процентах: ею обрезаем слой крови сверху.
        missing: Math.round((1 - pct) * 100)
      },
      ac: attr.ac?.value ?? "—",
      init: signed(attr.init?.total ?? attr.init?.mod ?? 0),
      speed: movement.walk ?? 0,
      units: UNITS[movement.units] ?? movement.units ?? "",
      // У заклинателей — СЛ заклинаний, у остальных — пассивная внимательность.
      extra: spellDC
        ? { value: spellDC, label: "СЛ заклинаний", short: "СЛ закл." }
        : { value: sys.skills?.prc?.passive ?? "—", label: "Пассивная внимательность", short: "пасс. вним." },
      move: movement_(actor, movement.walk ?? 0),
      modes: [
        { id: "advantage", label: "Преим.", cls: "adv" },
        { id: "normal", label: "Обычн.", cls: "" },
        { id: "disadvantage", label: "Помеха", cls: "dis" }
      ].map((m) => ({ ...m, active: m.id === rollMode })),
      canRest: actor.type === "character",
      basic: BASIC_ACTIONS,
      // Концентрация: dnd5e вешает на актёра состояние «concentrating».
      concentrating: actor.statuses?.has(CONFIG.DND5E?.specialStatusEffects?.CONCENTRATING ?? "concentrating"),
      // Героическое вдохновение (правила 2024) — флажок system.attributes.inspiration, только у персонажей.
      inspiration: { show: actor.type === "character", on: !!attr.inspiration },
      // При 0 ПЗ у персонажа вместо цифр в сфере — спасброски от смерти (attributes.death).
      death: actor.type === "character" && value <= 0 ? {
        successes: attr.death?.success ?? 0,
        failures: attr.death?.failure ?? 0,
        success: [0, 1, 2].map((i) => i < (attr.death?.success ?? 0)),
        failure: [0, 1, 2].map((i) => i < (attr.death?.failure ?? 0))
      } : null,
      panel: abilities,
      slots: spellSlots(actor)
    };
  }

  /** После отрисовки плавно «переливаем» кровь от старого уровня ПЗ к новому. */
  _onRender(context, options) {
    super._onRender?.(context, options);
    // HUD центрируется в свободной области слева от боковой панели Foundry (см. hud.css).
    this.element.style.setProperty("--kh-area-right", `${freeAreaRight()}px`);
    const blood = this.element.querySelector(".kh-orb-blood");
    const sameActor = this._lastActorId && this._lastActorId === this.actor?.id;
    if (blood && sameActor && this._lastMissing !== context.hp?.missing) {
      blood.animate(
        [{ clipPath: `inset(${this._lastMissing}% 0 0 0)` }, { clipPath: `inset(${context.hp.missing}% 0 0 0)` }],
        { duration: 600, easing: "ease-out" }
      );
    }
    this._lastMissing = context.hp?.missing;
    this._lastActorId = this.actor?.id;

    this.#bindTooltips();
  }

  /* ---------- Подсказка при наведении ---------- */

  /** Плитка, над которой сейчас мышь, и показано ли полное описание (зажат Shift). */
  #tip = { tile: null, full: false };

  /** Навешивает подсказку на плитки; Shift слушаем один раз на всё окно. */
  #bindTooltips() {
    // После перерисовки старых плиток уже нет в DOM — забываем их.
    this.#tip = { tile: null, full: false };
    for (const tile of this.element.querySelectorAll(".kh-tile")) {
      tile.addEventListener("mouseenter", () => this.#showTip(tile));
      tile.addEventListener("mouseleave", () => this.#hideTip());
      tile.addEventListener("focus", () => this.#showTip(tile));
      tile.addEventListener("blur", () => this.#hideTip());
    }
    if (this._shiftBound) return;
    this._shiftBound = true;
    const onKey = (event) => {
      if (event.key !== "Shift" || !this.#tip.tile) return;
      const full = event.type === "keydown";
      if (full !== this.#tip.full) this.#showTip(this.#tip.tile, full);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
  }

  async #showTip(tile, full = false) {
    const box = this.element.querySelector(".kh-tip");
    const data = this.actor && abilityTip(this.actor, tile.dataset.itemId, tile.dataset.activityId);
    if (!box || !data) return;
    this.#tip = { tile, full };

    box.replaceChildren();
    const add = (tag, cls, text) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    box.append(add("div", "kh-tip-name", data.name));
    if (data.sub) box.append(add("div", "kh-tip-sub", data.sub));
    if (data.stats.length) {
      const row = add("div", "kh-tip-stats");
      for (const st of data.stats) {
        const cell = add("span", "kh-tip-stat");
        cell.append(add("span", "kh-tip-stat-label", `${st.label} `), add("b", "", st.value));
        row.append(cell);
      }
      box.append(row);
    }
    const body = add("div", "kh-tip-desc");
    box.append(body);
    if (!full) box.append(add("div", "kh-tip-hint", "Зажмите Shift — полное описание"));

    box.classList.toggle("is-full", full);
    this.#placeTip(box, tile);
    box.hidden = false;

    if (full) {
      // Описание собирается асинхронно; если мышь уже ушла на другую плитку, ничего не делаем.
      const html = await enrichedDescription(data.source);
      if (this.#tip.tile !== tile || !this.#tip.full) return;
      body.innerHTML = html;
      this.#placeTip(box, tile);
    }
  }

  /** Подсказка над плиткой, над панелью; не вылезает за края центрального блока. */
  #placeTip(box, tile) {
    const center = this.element.querySelector(".kh-center");
    if (!center) return;
    const c = center.getBoundingClientRect();
    const t = tile.getBoundingClientRect();
    const half = box.offsetWidth / 2;
    const x = Math.clamp(t.left - c.left + t.width / 2, half - 40, c.width - half + 40);
    box.style.left = `${x}px`;
  }

  #hideTip() {
    this.#tip = { tile: null, full: false };
    const box = this.element.querySelector(".kh-tip");
    if (box) box.hidden = true;
  }

  /* ---------- Действия кнопок ---------- */

  static #openSheet() {
    this.actor?.sheet?.render(true);
  }

  static async #rollInitiative() {
    const actor = this.actor;
    if (!actor) return;
    if (typeof actor.rollInitiativeDialog === "function") return actor.rollInitiativeDialog({ createCombatants: true });
    return actor.rollInitiative({ createCombatants: true });
  }

  /**
   * Клик по плитке: используем активность так же, как кнопка на листе персонажа.
   * Дальше всё делает dnd5e (окно расхода ячеек и зарядов, карточка в чате), а Midi-QOL
   * подхватывает использование сам.
   */
  static async #useAbility(event, target) {
    const actor = this.actor;
    if (!actor) return;
    if (!actor.isOwner) {
      ui.notifications.warn("Это не ваш персонаж.");
      return;
    }
    const { itemId, activityId } = target.dataset;
    const item = actor.items.get(itemId);
    const activity = item?.system.activities?.get(activityId);
    if (!activity) {
      // Предмет успели удалить, а HUD ещё не перерисовался.
      ui.notifications.warn("Способность не найдена. Попробуйте ещё раз.");
      return this.render();
    }
    return activity.use({ event });
  }

  /**
   * Базовое действие: карточка в чат с кратким правилом.
   * Засада — ещё и проверка Скрытности. Если в Foundry есть подходящее состояние
   * (например, «уклонение»), оно включается или выключается на актёре.
   */
  static async #basicAction(event, target) {
    const actor = this.actor;
    const basic = BASIC_ACTIONS.find((b) => b.id === target.dataset.basic);
    if (!actor || !basic) return;
    if (!actor.isOwner) {
      ui.notifications.warn("Это не ваш персонаж.");
      return;
    }

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="kh-chat-basic"><h3>${basic.label}</h3><p>${basic.rule}</p></div>`
    });

    const status = basic.status && CONFIG.statusEffects.find((s) => s.id === basic.status);
    if (status) await actor.toggleStatusEffect(status.id);

    if (basic.skill) await actor.rollSkill({ skill: basic.skill, event });
  }

  static #setTab(event, target) {
    this.panel.tab = target.dataset.tab;
    this.panel.page = 0;
    this.render();
  }

  static #prevPage() {
    this.panel.page -= 1;
    this.render();
  }

  static #nextPage() {
    this.panel.page += 1;
    this.render();
  }

  /** Одна или две строки плиток; выбор запоминается в настройках клиента. */
  static async #toggleRows() {
    const tall = game.settings.get(MODULE_ID, "tallPanel");
    await game.settings.set(MODULE_ID, "tallPanel", !tall);
    this.panel.page = 0;
    this.render();
  }

  /** Героическое вдохновение: есть / нет. */
  static async #toggleInspiration() {
    const actor = this.actor;
    if (!actor?.isOwner) return;
    await actor.update({ "system.attributes.inspiration": !actor.system.attributes.inspiration });
  }

  /** Спасбросок от смерти — тот же бросок, что кнопка на листе персонажа. */
  static async #rollDeathSave(event) {
    const actor = this.actor;
    if (!actor?.isOwner) return;
    return actor.rollDeathSave({ event });
  }

  static #openSkills() {
    ui.notifications.info("Окно навыков появится в следующей версии HUD.");
  }

  static async #setRollMode(event, target) {
    await game.settings.set(MODULE_ID, "rollMode", target.dataset.mode);
    this.render();
  }

  static async #shortRest() {
    return this.actor?.shortRest?.();
  }

  static async #longRest() {
    return this.actor?.longRest?.();
  }
}

/* ---------- Подключение к Foundry ---------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "rollMode", {
    scope: "client",
    config: false,
    type: String,
    default: "normal"
  });

  game.settings.register(MODULE_ID, "tallPanel", {
    scope: "client",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "hideHotbar", {
    name: "Скрывать стандартную панель макросов",
    hint: "Пока HUD открыт, стандартная панель макросов внизу экрана прячется, чтобы не перекрываться с ним.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: (value) => document.body.classList.toggle("khvor-hide-hotbar", value)
  });
});

Hooks.once("ready", () => {
  const hud = new KhvorHud();
  game.modules.get(MODULE_ID).api = { hud };
  document.body.classList.toggle("khvor-hide-hotbar", game.settings.get(MODULE_ID, "hideHotbar"));

  // Перерисовка не чаще раза в 50 мс, даже если событий много подряд.
  const refresh = foundry.utils.debounce(() => hud.render({ force: true }), 50);
  const hooks = [
    "canvasReady", "controlToken", "updateToken", "updateActor", "updateCombat", "deleteCombat",
    "createItem", "updateItem", "deleteItem",
    "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"
  ];
  for (const hook of hooks) Hooks.on(hook, refresh);
  // Свернули или развернули боковую панель, изменили размер окна — пересчитать место и столбцы.
  Hooks.on("collapseSidebar", () => setTimeout(refresh, 300)); // после анимации сворачивания
  window.addEventListener("resize", refresh);
  refresh();
});
