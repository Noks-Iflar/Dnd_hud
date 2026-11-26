/**
 * HUD Хвора — основной скрипт модуля.
 * Версия 0.1: левый блок — сфера ПЗ, портрет, характеристики, режим броска, отдых.
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
      canRest: actor.type === "character"
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
