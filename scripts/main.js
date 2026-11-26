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
  { key: "items", label: "Предметы", gem: null }
];

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

/** Сколько столбцов плиток помещается на одной странице панели (одна плитка ≈ 64 px). */
const PAGE_COLUMNS = 12;

/** К какой вкладке относится плитка. */
function tileCategory(item, activity) {
  if (["consumable", "tool", "equipment", "loot"].includes(item.type)) return "items";
  if (item.type === "spell" || activity.type === "cast") return "spells";
  if (item.type === "weapon" || activity.type === "attack") return "attacks";
  return "features";
}

/**
 * Готовит панель к показу: оставляет плитки выбранной вкладки и режет их на страницы.
 * На странице rows × PAGE_COLUMNS плиток; группы, которые не попали на страницу, скрываются.
 * Возвращает группы страницы, вкладки и номер страницы.
 */
function paginate(groups, { tab, page, rows }) {
  const tabs = TABS.filter((t) => t.id === "all" || groups.some((g) => g.tiles.some((x) => x.category === t.id)));
  if (!tabs.some((t) => t.id === tab)) tab = "all";

  // Все плитки вкладки подряд, каждая помнит свою группу.
  const flat = groups.flatMap((g) => g.tiles.filter((x) => tab === "all" || x.category === tab).map((x) => [g, x]));
  const perPage = rows * PAGE_COLUMNS;
  const pages = Math.max(1, Math.ceil(flat.length / perPage));
  page = Math.clamp(page, 0, pages - 1);

  const shown = new Map();
  for (const [g, x] of flat.slice(page * perPage, (page + 1) * perPage)) {
    if (!shown.has(g.key)) shown.set(g.key, { ...g, tiles: [] });
    shown.get(g.key).tiles.push(x);
  }
  let pageGroups = [...shown.values()];
  // В режиме двух строк у группы половина столбцов: плитки идут слева направо, потом вторая строка.
  for (const g of pageGroups) g.cols = Math.max(1, Math.ceil(g.tiles.length / rows));
  // Базовые действия — на первой странице вкладки «Все».
  if (tab === "all" && page === 0) pageGroups = withBasicActions(pageGroups);

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

/** Мини-сетка базовых действий встаёт в группу «Действие»; если её нет, группа создаётся. */
function withBasicActions(groups) {
  let action = groups.find((g) => g.key === "action");
  if (!action) {
    action = { ...GROUPS[0], tiles: [] };
    groups.unshift(action);
  }
  action.basic = BASIC_ACTIONS;
  return groups;
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
 * Значки и состояние плитки:
 * - заряды «2/3» (сначала у самой активности, как «Огненный шар» 1/день, потом у предмета);
 * - перезарядка «5–6» (recovery с period "recharge" и порогом в formula);
 * - количество «×3» у расходников;
 * - цена легендарного действия ромбами;
 * - spent — плитка бледнеет: заряды кончились или не хватает легендарных действий.
 */
function tileState(actor, item, activity, groupKey) {
  const uses = usesLeft(activity.uses) ?? usesLeft(item.system.uses);
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

  for (const item of items) {
    if (item.getFlag("dnd5e", "cachedFor")) continue;
    // Заклинания игроков добавим, когда будет выгрузка листа игрока: нужно понять, как хранится подготовка.
    if (item.type === "spell") continue;
    // Оружие и снаряжение — только надетое.
    if (["weapon", "equipment"].includes(item.type) && !item.system.equipped) continue;

    const activities = item.system.activities;
    if (!activities?.size) continue; // пассивные черты без действий

    // Коллекция Foundry при for...of отдаёт значения, а не пары.
    for (const activity of activities) {
      const groupKey = item.type === "consumable" ? "items" : activity.activation?.type;
      if (!groups[groupKey]) continue; // «особое», «минута», «час» и т. п. в панель не попадают

      const spell = activity.type === "cast" ? cachedSpells.get(`.Item.${item.id}.Activity.${activity.id}`) : null;
      const img = spell?.img ?? (isGenericIcon(activity.img) ? item.img : activity.img);
      // Имя активности нужно, только если у предмета их несколько (заклинания дракона).
      const name = ruName(activities.size > 1 && activity.name ? activity.name : item.name);

      groups[groupKey].push({
        itemId: item.id, activityId: activity.id, name, label: tileName(name), img,
        category: tileCategory(item, activity),
        ...tileState(actor, item, activity, groupKey)
      });
    }
  }

  return GROUPS
    .map((g) => ({ ...g, tiles: groups[g.key] }))
    .filter((g) => g.tiles.length > 0);
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
      rows: game.settings.get(MODULE_ID, "tallPanel") ? 2 : 1
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
        ? { value: spellDC, label: "СЛ заклинаний" }
        : { value: sys.skills?.prc?.passive ?? "—", label: "Пасс. внимат." },
      modes: [
        { id: "advantage", label: "Преим.", cls: "adv" },
        { id: "normal", label: "Обычн.", cls: "" },
        { id: "disadvantage", label: "Помеха", cls: "dis" }
      ].map((m) => ({ ...m, active: m.id === rollMode })),
      canRest: actor.type === "character",
      panel: abilities
    };
  }

  /** После отрисовки плавно «переливаем» кровь от старого уровня ПЗ к новому. */
  _onRender(context, options) {
    super._onRender?.(context, options);
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
    "canvasReady", "controlToken", "updateToken", "updateActor",
    "createItem", "updateItem", "deleteItem",
    "createActiveEffect", "updateActiveEffect", "deleteActiveEffect"
  ];
  for (const hook of hooks) Hooks.on(hook, refresh);
  refresh();
});
