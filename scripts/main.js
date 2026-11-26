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

/** «Раздирание [Rend]» → «Раздирание»: английское название в квадратных скобках не нужно. */
const ruName = (name) => (name ?? "").replace(/\s*\[[^\]]*\]\s*$/, "").trim();

/** Подпись на плитке короче: «Рассеивание магии (2/день)» → «Рассеивание магии». */
const tileName = (name) => name.replace(/\s*\([^)]*\)\s*$/, "").trim();

/** Стандартные значки dnd5e (например, силуэт монстра) хуже картинки самого предмета. */
const isGenericIcon = (img) => !img || img.startsWith("systems/dnd5e/icons/svg/");

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

      groups[groupKey].push({ itemId: item.id, activityId: activity.id, name, label: tileName(name), img });
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
      shortRest: KhvorHud.#shortRest,
      longRest: KhvorHud.#longRest
    }
  };

  static PARTS = {
    hud: { template: `modules/${MODULE_ID}/templates/hud.hbs` }
  };

  /** Актёр, которого сейчас показывает HUD. */
  actor = null;

  /** Собирает данные для шаблона. */
  async _prepareContext() {
    this.actor = findActor();
    document.body.classList.toggle("khvor-hud-active", !!this.actor);
    const actor = this.actor;
    if (!actor) return { actor: false };

    const sys = actor.system;
    const attr = sys.attributes ?? {};

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
      groups: collectAbilities(actor)
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
