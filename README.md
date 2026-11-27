# HUD Хвора

Боевой HUD в стиле тёмного фэнтези для Foundry VTT (V14, dnd5e 6.1.1), кампания «Хвор».

## Установка

Foundry → **Add-on Modules** → **Install Module** → в поле **Manifest URL** вставить:

```
https://github.com/Noks-Iflar/Dnd_hud/releases/latest/download/module.json
```

Обновления потом ставятся кнопкой обновления в том же списке модулей.

Рекомендуется socketlib (для «Помощи» на чужое существо). Работает вместе с Midi-QOL и Automated Conditions 5e.

## Выпуск новой версии

Поднять `version` в `module.json` и влить в `main` — GitHub Actions (`.github/workflows/release.yml`) соберёт `module.zip` и создаст релиз.

Шрифты (Cormorant Garamond, Alegreya Sans, Alegreya Sans SC) лежат в `fonts/`, лицензия SIL OFL 1.1.
