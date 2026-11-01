# 25 — Barre de touches mobile & clavier code

Ajoutée le 2026-10-31 pour le terminal sur téléphone. La barre fonctionne avec le
**clavier natif** ; le clavier code ne sert qu'aux touches supplémentaires.

## Barre de touches

| Élément | Rôle |
|---|---|
| `⌄` | Range le clavier : blur de l'input miroir + masque tout |
| `⌨` | Ouvre le **clavier code** (masque le clavier natif) |
| `Esc`, `Tab`, `⇧Tab` | Touches spéciales |
| `Ctrl` | Modificateur : 1 appui = one-shot, 2 appuis rapides / appui long = verrouillé |
| `↑ ↓ ← →` | Flèches |

- Déclencheur : `pointerdown` / `touchstart` capturés dans l'iframe du terminal.
- Masquage : tap hors barre, verrouillage, `⌄`, ou perte de focus **hors `#mkInput`**.
- Position : `bottom: var(--kb)` (`--kb = innerHeight − vv.height − vv.offsetTop`).
- `body.mkeys-on` masque la ligne de monitoring ; z-index **94** (sous les modales).

## Entrée du clavier natif : input miroir `#mkInput`

Le focus est le point fragile quand on mélange barre (page parente), clavier natif et
iframe ttyd. Solution : un **input invisible dans la page parente**.

- `#mkInput` : 1×1 px, `opacity:.01`, `font-size:16px`, `pointer-events:none`,
  `autocomplete/autocapitalize/autocorrect off`, `spellcheck=false`.
- Au tap dans le terminal : `focusInput()` (immédiat + retry 40 ms). Le clavier natif
  s'ouvre pour cet input, pas pour le textarea de l'iframe.
- Toute la frappe passe par ses listeners :
  - `beforeinput` : `deleteContentBackward` → `\x7f` ; caractère unique → `sendChar`.
  - `keydown` : Enter → `\r`, Backspace, Tab, Escape, Delete, flèches, Home/End,
    PgUp/PgDn.
  - `input` : repli si `beforeinput` n'a pas fourni de données.
- Envoi final via **`window.term.input()`** (xterm exposé par ttyd), donc fiable même
  si l'iframe n'a pas le focus.
- Le `focusout` de l'iframe **ne masque pas** la barre quand `#mkInput` est focalisé
  (sinon elle disparaissait ~380 ms après le tap).
- « Clavier principal » (clavier code) refocalise `#mkInput` → clavier natif.

## Modificateurs (Ctrl / Alt / ⇧)

- **1 appui** = one-shot : surlignage léger, s'applique à la **touche suivante** puis
  s'éteint (y compris après une frappe native).
- **2 appuis rapides (< 500 ms)** ou **appui long (≥ 550 ms)** = **verrouillé** :
  bouton plein (couleur accent), reste actif après usage.
- Appui sur un modificateur verrouillé = extinction.
- Barre et clavier code partagent le même état.
- Conversions : Ctrl → `char & 0x1f` (Ctrl+L → `\x0c`), Alt → préfixe `\x1b`,
  Shift → majuscule pour les lettres.

## Clavier code (remplace temporairement le clavier natif)

Quand on touche `⌨` :

1. blur de `#mkInput` → le clavier natif se ferme ;
2. `#codekb` s'affiche ancré en bas, **190 px → 38 vh** (44 vh écran court),
   touches 31 px, z-index **93** (sous les modales) ;
3. la barre est masquée et `body.ck-on` réserve `--ck-h` en `margin-bottom` de `#main`
   → le terminal rétrécit.

### Contenu

- **Contrôle** : Esc, Tab, ⇧Tab, Ctrl, Alt, ⇧, ⌫, ⏎, Espace.
- **Raccourcis** : `^C ^D ^Z ^L ^A ^E ^U ^K ^R ^W`.
- **Défilement** : `⤒ Historique` (copy-mode tmux) / `⤓ Direct` (bas / sort du copy-mode).
- **Navigation** : Home, End, PgUp, PgDn, Del, Ins, ↑ ↓ ← →.
- **Symboles** (32), **Chiffres**, **Lettres** a–z, **Fonctions** F1–F12.

## Séquences envoyées

| Touche | Séquence |
|---|---|
| Esc / Tab / ⇧Tab / Enter / ⌫ | `\x1b` / `\t` / `\x1b[Z` / `\r` / `\x7f` |
| Flèches | `\x1b[A B C D` (modifiées `\x1b[1;{m}A`) |
| Home / End / PgUp / PgDn | `\x1b[H` / `\x1b[F` / `\x1b[5~` / `\x1b[6~` |
| Suppr / Inser | `\x1b[3~` / `\x1b[2~` |
| F1–F4 / F5–F12 | `\x1bOP…S` / `\x1b[15~ … 24~` |

`{m}` = `1 + shift(1) + alt(2) + ctrl(4)`.

## Défilement (deux doigts + boutons)

tmux est en écran alterné et une application plein écran (Marexcode, vim…) peut
capturer la souris. Le mono-doigt **n'est pas intercepté** pour ne pas gêner le TUI.

- **Glissement à deux doigts** dans le terminal → **copy-mode** (`Ctrl+B [` /
  `\x02[`), puis `\x1b[A` (plus ancien) / `\x1b[B` (plus récent) tous ~22 px.
- **FAB vertical** à droite du terminal (visible avec la barre, masqué quand le
  clavier code s'ouvre) :
  - `▲` : entre en historique et remonte de 6 lignes ;
  - `▼` : redescend de 6 lignes ;
  - `●` (Direct) : sort du copy-mode (`q`) et revient au direct.
- **Toute frappe** sort d'abord du copy-mode avant d'envoyer la touche.
- Clavier code : `⤒ Historique` / `⤓ Direct`.
- `marex-tmux` garde `mouse on` (molette desktop) ; repli `term.scrollLines()` hors
  écran alterné.
- Vérifié : 1 doigt → `pane_in_mode=0` ; 2 doigts → `1` ; FAB `●` → `0`.

## Responsive

- Portrait 390×844 : panneau **321 px**, `#main` ~520 px.
- Paysage 844×390 (pointeur grossier) : panneau ≤ 44 vh.
- 320×568 : panneau ≤ 38 vh, scrollable.
- Desktop (`min-width:821px` **et** `pointer:fine`) : barre et panneau masqués.

## Pièges

- Le panneau et la barre restent **sous** les modales (z-index < 100).
- Ne pas refocaliser le textarea de l'iframe quand le clavier code est ouvert.
- Le `focusout` de l'iframe doit être ignoré si `#mkInput` est focalisé.
- `[data-char="c"]` matche aussi `^C` : viser le groupe « Lettres » dans les tests.
- `device_scale_factor=2` en headless Chromium peut blanchir le canvas xterm.
- Ne jamais insérer avant `<!DOCTYPE html>` lors d'un patch (sinon texte parasite).

## Fichiers

- `index.html` : `#mkInput`, `#mkeys`, `#codekb`, IIFE « barre de touches mobile »
  (`focusInput`, `nativeInput`, `sendKey`, `sendChar`, `sendWheel`, `tapMod`,
  `openCodeKb`, `closeCodeKb`).
- `marex-tmux` (102) : `status off` + `mouse on`.
- Après modification de la page : `marexcode-web-deploy` (CSP par hachages).
