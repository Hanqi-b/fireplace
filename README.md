# <img src="/logo.png" height="32" width="32"/> Fireplace
[![](https://img.shields.io/badge/python-3.10+-blue.svg)](https://peps.python.org/pep-0619/)
[![](https://img.shields.io/github/license/jleclanche/fireplace.svg)](https://github.com/jleclanche/fireplace/blob/master/LICENSE.md)
[![](https://github.com/jleclanche/fireplace/actions/workflows/build.yml/badge.svg)](https://github.com/jleclanche/fireplace/actions/workflows/build.yml)
[![codecov](https://codecov.io/github/jleclanche/fireplace/graph/badge.svg?token=FXDTJSKZL9)](https://codecov.io/github/jleclanche/fireplace)
[![Code style: black](https://img.shields.io/badge/code%20style-black-000000.svg)](https://github.com/psf/black)

A Hearthstone simulator and implementation, written in Python.


## Cards Implementation

Now updated to [Patch 17.6.0.53261](https://hearthstone.wiki.gg/wiki/Patch_17.6.0.53261)
* **100%** Basic (153 of 153 cards)
* **100%** Classic (240 of 240 cards)
* **100%** Hall of Fame (35 of 35 cards)
* **100%** Curse of Naxxramas (30 of 30 cards)
* **100%** Goblins vs Gnomes (123 of 123 cards)
* **100%** Blackrock Mountain (31 of 31 cards)
* **100%** The Grand Tournament (132 of 132 cards)
* **100%** Hero Skins (33 of 33 cards)
* **100%** The League of Explorers (45 of 45 cards)
* **100%** Whispers of the Old Gods (134 of 134 cards)
* **100%** One Night in Karazhan (45 of 45 cards)
* **100%** Mean Streets of Gadgetzan (132 of 132 cards)
* **100%** Journey to Un'Goro (135 of 135 cards)
* **100%** Knights of the Frozen Throne (135 of 135 cards)
* **100%** Kobolds & Catacombs (135 of 135 cards)
* **100%** The Witchwood (129 of 129 cards)
* **100%** The Boomsday Project (136 of 136 cards)
* **100%** Rastakhan's Rumble (135 of 135 cards)
* **100%** Rise of Shadows (136 of 136 cards)
* **100%** Saviours of Uldum (135 of 135 cards)
* **100%** Descent of Dragons (140 of 140 cards)
* **100%** Galakrond's Awakening (35 of 35 cards)
* **100%** Ashes of Outlands (135 of 135 cards)
* **100%** Scholomance Academy (1 of 1 card)
* **100%** Demon Hunter Initiate (20 of 20 cards)

## Requirements

* Python 3.10+


## Installation

> **Note**: This repository uses Git LFS (Large File Storage). Please install Git LFS before cloning: https://git-lfs.com

* `pip install .`


## Documentation

The [Fireplace Wiki](https://github.com/jleclanche/fireplace/wiki) is the best
source of documentation, along with the actual code.

## Human game and decision log

### Local browser game

Install the package with `pip install .`, then start the local browser app:

```bash
fireplace-web --seed 7
```

Open [http://127.0.0.1:8765/](http://127.0.0.1:8765/) on the same computer.
The equivalent source-checkout command is `python3 examples/play_web.py --seed 7`;
`python3 -m fireplace.web_gui` also works. Use `--port 8766` to choose another
port. The server binds to `127.0.0.1`. Enter a local nickname, choose Chinese
or English and a Random or Heuristic AI opponent, then start a match. Each match
draws random classes and 30-card decks. The nickname and language preference are
saved only in this browser; there is no password or network account. Language
can be changed on the start screen and stays fixed during a match. After Game
Over, return to the start screen to change settings or play again without
restarting the server. `--opponent heuristic` sets the initial opponent choice
and `--seed` makes the first game's random setup reproducible. Press Ctrl+C in
the terminal to stop the server.

The browser receives only the human player's Observation, current legal Action
values and a filtered public event log. Click cards, characters and offered
choices to play through Mulligan, the main phase, Discover and Game Over. A
stale action refreshes the page's game state and must be selected again.
The battlefield shows both hero portraits and minion rows, with a larger hand
along its lower edge. Click a playable card, attacker or hero power, then choose
any highlighted target, branch or minion slot. On desktop, hover or focus a
card to enlarge it. On narrow screens, use its inspect button for full card
details while the hand remains scrollable. The public match log,
convenience action buttons and a complete legal-action fallback are below the
battlefield, so they do not cover play. The narrow layout keeps the hand in a
horizontal strip. The scene is a local static image; no gameplay information is
embedded in it.
Localized card text comes from `CardDefs.xml` in the selected match language.
Card images are fetched by the local server as renders, art or tiles and cached
outside the repository in
`$XDG_CACHE_HOME/card_assets` (or `~/.cache/card_assets`). A missing image or
unavailable asset package falls back to a CSS card placeholder. The browser
does not request external card-image URLs. The first uncached image may take
time to arrive; gameplay remains responsive while it loads.

For browser acceptance testing, install Node.js, Playwright and Chrome, then
run `node tests/web_gui_browser_smoke.cjs` from the repository root. Set
`FIREPLACE_GUI_PYTHON` to the Python interpreter with Fireplace installed and
`CHROME_PATH` if Chrome is not at `/opt/google/chrome/chrome`. The script plays
a deterministic real-engine match through the GUI, including a stale action,
and writes desktop, narrow-window and Game Over screenshots under
`/tmp/fireplace-web-gui-artifacts` by default.
Run `node tests/web_gui_full_match.cjs` with the same environment variables to
play complete browser matches against Random in Chinese and Heuristic in
English on one local server. It uses battlefield clicks and the end-turn button
across multiple turns, returns to the start screen after each result, and checks
that an action from the earlier session is rejected. Run
`node tests/web_gui_locale_browser.cjs` for a short offline browser check that
card names, rules text, and renders follow the selected language.

### Terminal game

Run a terminal game against the random agent from a source checkout:

```bash
python3 examples/human_vs_random.py --seed 7 --log games/match.json
```

To play against the deterministic rule-based baseline instead, select the
heuristic opponent:

```bash
python3 examples/human_vs_random.py --opponent heuristic --seed 7
```

The heuristic chooses among the same legal actions as the random agent. It
uses only the acting player's visible observation, so it cannot inspect the
opponent's hidden hand or deck. It is a simple baseline, not a card-effect
simulator.

The optional log contains accepted player decisions, the initial decks, a
pre-start RNG snapshot, and the result. It is saved after each decision, so an
interrupted game leaves a partial log. It may reveal both players' private
cards and choices; keep the file private.

Replay and verify a completed standard game with the same Python, Fireplace,
and card-data versions:

```bash
python3 examples/replay_log.py games/match.json
```

Replay starts at the beginning, applies the recorded decisions, and compares
the final normalized game state. Logs attached after a game starts and older
decision logs without a pre-start RNG snapshot cannot be replayed. UUIDs and
wall-clock timestamps are excluded from the comparison.


## License

[![AGPLv3](https://www.gnu.org/graphics/agplv3-88x31.png)](http://choosealicense.com/licenses/agpl-3.0/)

Fireplace is licensed under the terms of the
[Affero GPLv3](https://www.gnu.org/licenses/agpl-3.0.en.html) or any later version.


## Community

Fireplace is a [HearthSim](http://hearthsim.info/) project.
Join the community: <https://hearthsim.info/join/>
