# Third-Party Notices & Attribution

This project incorporates visual layout structures, color palettes, facility theming, current 14-QR and legacy 16-QR layout constants, and interoperability protocols adapted from **Arknights Mower**:

- **Project:** Arknights Mower (arknights-mower)
- **Author:** Nano & Contributors
- **Repository:** https://github.com/ArkMowers/arknights-mower
- **License:** MIT License
- **Copyright:** Copyright (c) 2021 Nano

---

## MIT License Notice

The exact license notice from the Arknights Mower source repository (`LICENSE`) is reproduced below in accordance with MIT License requirements:

```
MIT License

Copyright (c) 2021 Nano

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Architecture & Compatibility Scope

### Unicode Character Names

The safe condition interpreter uses character names and aliases from Unicode 15.0.0 to match Python 3.12 named string escapes. Fixed source URLs, hashes and offline regeneration are recorded in [scripts/unicode-escape-names/sources.json](scripts/unicode-escape-names/sources.json). The Unicode data license is included in [public/licenses/Unicode-Data-License.txt](public/licenses/Unicode-Data-License.txt) and distributed as `licenses/Unicode-Data-License.txt` in the frontend.

### 1. Core Main-Roster Scope (`plan1` / Active Default Plan)
The compatibility layer focuses strictly on the **main roster workbench** (`plan1` and the active default plan) and its global configuration (`conf`).
- **Facilities Model:** Covers the 19 facility cards:
  - **9 Output Rooms:** 3×3 grid of production facilities (`room_1_1` through `room_3_3`), supporting Manufacture (`manufacture`), Trading (`trading`), and Power (`power`).
  - **1 Central Control Room:** `central` (up to 5 operator slots).
  - **4 Dormitories:** `dormitory_1` to `dormitory_4` (up to 5 operator slots each, Lv.1–5).
  - **5 Functional Facilities:** Meeting Room (`meeting`), Workshop (`factory`), Office (`contact`), Training Room (`train`), optional Recycling Station (`recycle`, one slot at Lv.1 and two at Lv.2–3; no power consumption).
  - **3 Activity Rooms:** Reserved entries (`gaming_1` to `gaming_3`).
- **Visual Fidelity:** Reproduces Mower's 980px fixed-width canvas layout, facility card dark/light theming, facility category left-border accents, product watermarks (gold, exp3, orirock, lmd, orundum), 45px operator portraits, and drag-and-drop room swapping.

### 2. JSON & 14/16-QR JPG Interchange
- **Lossless JSON Codec (`mowerJson.ts`):**
  - Reads and emits Mower's native top-level JSON structure (`default`, `plan1`, `conf`, `backup_plans`, etc.).
  - Unrecognized fields, secondary plans (`otherPlans`), and metadata are preserved losslessly inside `MowerCompatibilityEnvelope` without corruption across import/export cycles.
  - Normalizes and translates Mower product keys (`gold`, `exp3`, `orirock`, `lmd`, `orundum`).
- **QR JPG Codec (`mowerQrCodec.ts`, `base45.ts`, `mowerQrConstants.ts`):**
  - Follows `arknights_mower/utils/qrcode.py`: zlib level 9 compression, RFC 9285 Base45 encoding, and floor-split data chunks without custom headers. Current product export uses 14 chunks; import accepts complete 14- or 16-chunk images.
  - Current layout places seven QR codes above and seven below the output-room grid. Legacy 16-QR imports also include the lower-right pair; current exports preserve that space for the fifth support facility.
  - Decodes images via iterative `jsQR` with canvas masking and geometric coordinate sorting (Top-to-Bottom, Left-to-Right), with **zero OCR** dependency.

### 3. Intelligent 2/3-Power-Plant Facility Level Inference
Mower plan files do not store facility levels directly; levels are deduced based on the facility layout and power plant count:
- **3 Power Plants (Typical 243 / 333 layouts):**
  - Sufficient power generation (810 kW) supports maximum facility upgrades across the base.
  - All 9 output rooms are inferred to **Lv.3**.
  - All 4 dormitories are inferred to **Lv.5**.
  - Control central is inferred to **Lv.5**.
  - Right functional facilities (`meeting`, `contact`, `factory`, `train`) are inferred to **Lv.3**.
- **2 Power Plants (Typical 252 / 342 low-power setups):**
  - Tight power budget requires stepped facility level inference:
  - All 4 dormitories are inferred to **Lv.1**.
  - Power plants are inferred to **Lv.3**.
  - Right functional facilities (`meeting`, `contact`, `factory`, `train`) remain **Lv.3**; central remains **Lv.5**.
  - Output rooms (`manufacture`, `trading`) infer levels from active operator count:
    $$\text{level} = \max(1, \min(3, \text{staffedCount} \parallel 1))$$

### 4. Pure AppConfig Adapter & Calculation Bridge
- **Calculation Boundaries:** New support effects are implemented in independent `src/engine/supportFacilities/` modules. Morale, global context and existing conditional rules are extended only where the new mechanism affects them. Fixed-roster before/after baselines and numerical regression tests verify existing behavior; static projections do not prove dynamic Mower scheduling or game execution.
- **Pure Adapter (`compileMainPlanToAppConfig`):**
  - Compiles the Schema-v8 `RosterWorkspace` and `MowerMainPlan` into the Schema-v7 `AppConfig` format expected by `calculate()`.
  - Maps primary operator slots, converts the first replacement into `operatorBackups`, and aggregates grouped operators into `operatorGroups`.
  - Gracefully handles placeholder occupants (`Free`, `Current`, `Empty`) by filtering them out of active yield simulation.

### 5. Alpha Scheduling and Settings Adaptation
- The 2026-10-25 full source audit and repairs retain the earlier fixed sources and add Mower alpha `f19abfa3a53489d018c6eabd115b6cb68afcdc66` startup order observations. Expression/schema probes target the release's Python 3.12 runtime and Unicode 15.0. Five common formula errors are intentionally corrected under the user's explicit local-model choice. Source hashes and verification boundaries are recorded in the skill source manifest and [UPDATE_PLAN.md](UPDATE_PLAN.md).
- The 2026-10-24 mechanism update is pinned to Mower alpha `84e3926c0f36045d7baeb1ac050f815b40952d6d`: backup functions, recovery observations/deadlines, ordinary replacement checks, group execution confirmation, dynamic full-mood beds and confirmed-position warmup. Scope, native/local differences and source hashes are recorded in [the update note](docs/UPDATE_2026-10-24_MOWER_LATEST.md) and the skill source manifest. The MIT attribution above applies to the adapted code.
- Current compatibility source: Mower alpha `ab0a4e5bec23f6f8d7c37b0648f05dda28f31866` (MIT). Adapted decisions include backup configuration layering, group bindings, shared replacements, dorm ordering/isolation, morale limits, product switching and plan validation. Settings labels and form organization follow the source Vue components.
- The local simulator supports a documented subset of the scheduling lifecycle and ideal trade-order model. It does not execute ADB, device recognition, training tasks or the complete native product-switch staffing/locking sequence. Historical fixtures retain their original source revisions.
- Unknown JSON fields are preserved structurally. Retired fields are migrated explicitly; preserved unsupported backup expressions produce diagnostics. Re-serialized JSON is not claimed to be byte-identical.
- Source hashes, independently generated native decision fixtures and their scope are recorded in [the alpha validation directory](validation/mower-alpha-2026-10-13/README.md).
