# Peer Review v2: Engineering & Statistical Feedback on the Revised `VTSR next-gen analysis` Plan

**Audience:** Claude / `vt-stats` rating-system developer  
**Context:** Follow-up review of the `2026-11-20` revised `VTSR next-gen analysis` plan (incorporating the $800$-game corpus empirical tests against Peer Review v1).  
**Purpose:** Confirm validated updates, correct one genuine statistical bug in the proposed damage likelihood before `critique/decisions/joint-skill-model.md` is frozen, resolve UI/spec edge cases, and provide clear engineering recommendations on the four remaining open decisions.

## 1. Executive Summary & Concessions

This revision is a major step forward. Rather than accepting Peer Review v1 at face value, testing every claim directly against the $800$-game corpus produced a much stronger, cleaner plan.

In particular, five points where your empirical tests rightly overruled my first review should be treated as settled:

1. **Confirmation Power & Sequential Thresholds:** Simulating the promote rule and proving that $60$ duels yields only $16\%\text{--}25\%$ power—whereas $180\text{--}400$ duels with a $\approx 2.2\text{ SE}$ per-look threshold are required to hold a $5\%$ false-pass rate across looks—saves the project from an underpowered gate.
2. **Time Decay & Correlated Prior ($\rho = 0.6$) as Grid Candidates:** Out-of-sample log-loss degraded under both static assumptions ($0.5922 \to 0.5937\text{--}0.6026$ for decay; $0.5901 \to 0.5940$ for $\rho = 0.6$). Treating both as candidates rather than fixed assumptions is strictly better methodology.
3. **Drift Decomposition:** Demonstrating that the $1000$ floor has zero effect on the corpus, that the commander allowance ($+115$ points) and loss aversion ($+64$ points) oppose an underlying deflation to $1375$, and that centering via the joint model's prior removes drift cleanly by construction corrects my earlier attribution.
4. **Scrap-per-HP Inversion:** Confirming that extractors ($4.0$ scrap/$1{,}000\text{ HP}$) and scavengers ($6.7$) are cheaper per hit point than scouts ($11\text{--}33$) and tanks ($15.7$). Keeping target-class decoding in the backlog because the PvE weight sweep is flat—rather than for a faulty cost intuition—is the right justification.
5. **Keeping the Commander Economy Composite Inert:** Leaving the already-wired composite silently logged under its own rule costs zero maintenance and avoids prematurely retiring it on $14\text{--}16$ commanders.

Before freezing `critique/decisions/joint-skill-model.md` and implementing `joint-model-forensic`, however, there are **four concrete technical traps**—including one mathematical error in the damage-observation noise specification—plus four missing edge-case rules that must be resolved.

## 2. Four Technical Traps to Fix Before Freezing the Memo

### 2.1 Trap 1: The Centered Log-Ratio Variance Bug (Over-Weighting $3\text{v}3$s)

**The Problem:**  
In the revised proposal, you observed that the empirical standard deviation of the own-team centered log-ratio grows with team size ($0.24, 0.32, 0.38$ raw; residual noise $0.21, 0.27, 0.32$ for $k = 2, 3, 4$ thugs) and proposed setting the Gaussian likelihood noise directly to `noise(team size) = (0.21, 0.27, 0.32)` across the $k$ thug rows.

**Why This Is Mathematically Incorrect:**  
Suppose each thug $i \in \{1, \dots, k\}$ on a team generates an uncentered log-damage observation:

$$
y_i = \mu_{\text{team}} + \beta F_i + \varepsilon_i, \qquad \varepsilon_i \stackrel{\text{i.i.d.}}{\sim} \mathcal{N}(0, \sigma_{0,k}^2)
$$

Subtracting the team mean $\bar{y} = \frac{1}{k}\sum_{j=1}^k y_j$ applies the orthogonal projection matrix $P = I_k - \frac{1}{k}\mathbf{1}\mathbf{1}^T$ (which has rank $k - 1$ and satisfies $P^2 = P$, $P^+ = P$). Two exact consequences follow:

1. **Projection Shrinkage Explains Most of the Spread Drop:**  
   The centered residual $r_i = \varepsilon_i - \bar{\varepsilon}$ has marginal variance:

   $$
   \text{Var}(r_i) = \frac{k - 1}{k}\sigma_{0,k}^2
   $$

   De-projecting your measured residual SDs by dividing by $\sqrt{(k-1)/k}$ reveals the true underlying per-thug noise $\sigma_{0,k}$:
   * $k = 2$ ($3\text{v}3$): $0.21 / \sqrt{1/2} = 0.297$
   * $k = 3$ ($4\text{v}4$): $0.27 / \sqrt{2/3} = 0.331$
   * $k = 4$ ($5\text{v}5$): $0.32 / \sqrt{3/4} = 0.370$

2. **Exact Multivariate Normal Likelihood Uses $\sigma_{0,k}^2$, Not $\frac{k-1}{k}\sigma_{0,k}^2$:**  
   Because the centered vector $\mathbf{r} = P\boldsymbol{\varepsilon}$ lives on a $(k-1)$-dimensional subspace with singular covariance $\Sigma = \sigma_{0,k}^2 P$, its exact $(k-1)$-dimensional negative log-likelihood (up to an additive constant) is:

   $$
   -\ell_{\text{thugs}} = \frac{1}{2}\mathbf{r}^T \Sigma^+ \mathbf{r} = \frac{1}{2\sigma_{0,k}^2}\mathbf{r}^T P \mathbf{r} = \frac{1}{2\sigma_{0,k}^2}\sum_{i=1}^k r_i^2
   $$

   Notice the denominator is $\sigma_{0,k}^2$, **not** $\hat{s}_k^2 = \frac{k-1}{k}\sigma_{0,k}^2$. If you plug the centered SDs ($0.21, 0.27, 0.32$) directly into an independent sum over all $k$ thugs, you double-count the zero-sum constraint and inflate the Fisher information of every $3\text{v}3$ thug row by $\frac{k}{k-1} = 2.0\times$ (every $4\text{v}4$ by $1.5\times$, and every $5\text{v}5$ by $1.33\times$). That systematically over-weights $3\text{v}3$ damage observations relative to $5\text{v}5$s and relative to binary match outcomes.

**Exact Fix for the Likelihood:**  
1. In the thug damage term, use the de-projected per-player noise $\sigma_{0,k} = \hat{s}_k / \sqrt{(k-1)/k}$ ($\approx 0.30, 0.33, 0.37$ for $k = 2, 3, 4$) in the denominator:

   $$
   -\ell_{\text{thugs}} = \frac{1}{2\sigma_{0,k}^2}\sum_{i=1}^k \Big( (y_i - \bar{y}) - \beta (F_i - \bar{F}_{\text{thugs}}) \Big)^2
   $$

2. **Commander Row Exactness (Zero Cross-Covariance):**  
   For the commander observation $z_c = y_c - \bar{y}_{\text{thugs}}$, the residual is $e_c = \varepsilon_c - \bar{\varepsilon}_{\text{thugs}}$. For every thug $i \in \{1, \dots, k\}$:

   $$
   \text{Cov}(e_c, r_i) = \text{Cov}(\varepsilon_c - \bar{\varepsilon}_{\text{thugs}}, \; \varepsilon_i - \bar{\varepsilon}_{\text{thugs}}) = -\text{Cov}(\bar{\varepsilon}_{\text{thugs}}, \varepsilon_i) + \text{Var}(\bar{\varepsilon}_{\text{thugs}}) = -\frac{\sigma_{0,k}^2}{k} + \frac{\sigma_{0,k}^2}{k} = 0
   $$

   Because the commander residual is **strictly orthogonal** to every centered thug residual, the joint Gaussian damage likelihood factorizes **exactly** into the thug sum above plus the independent commander term with variance $\sigma_{\text{cmdr\_obs}, k}^2 = \sigma_{\text{cmdr}}^2 + \sigma_{0,k}^2 / k$:

   $$
   -\ell_{\text{cmdr}} = \frac{1}{2\sigma_{\text{cmdr\_obs}, k}^2}\Big( (y_c - \bar{y}_{\text{thugs}}) - \beta (F_c - \bar{F}_{\text{thugs}}) - \delta_c \Big)^2
   $$

   Verify the empirical variance of $e_c$ by team size ($k = 2, 3, 4$) in Todo #1 so $\sigma_{\text{cmdr\_obs}, k}$ is calibrated cleanly alongside $\sigma_{0,k}$.

### 2.2 Trap 2: The Stage 1 / Stage 2 Split-Brain UI Problem

**The Problem:**  
Under the proposed two-stage promote rule:
* **Stage 1 ($100$ recorded duels, $\sim 5$ weeks):** Switches the live **Balonce Meter** to the joint model's win probability.
* **Stage 2 ($180\text{--}400$ duels, $\sim 3\text{--}5$ months, or possibly never):** Keeps published **VTSR-T bands** and **VTSR-C numbers** on the canonical ladders until the strict threshold passes.

Your own diagnostics show why this creates an acute transparency hazard: **6 of 24 ladder players move by more than $100$ points** between canonical VTSR-T and joint $F$ (Domakus $-151$, Nomad $-134$, Cyber $+132$, Certified Bad Guy $+121$). For months between Stage 1 and Stage 2:
* A lobby card on Tools and the Outcome card will show canonical VTSR-C numbers and VTSR-T bands that favor Team 1, while the Balonce Meter prints a win probability favoring Team 2 using hidden numbers.
* `VTBalonce.mainReason()` (`commander_edge`, `thug_edge`, `stacked`) will either lie (explaining a joint-model probability with canonical drivers) or cite drivers that contradict the visible leaderboard bands on the same screen.

**Recommended Fixes (Pick One Before Freezing the Memo):**
* **Option A (Cleaner UX — Recommended):** At Stage 1 ($100$ duels), promote the joint model to a **visible secondary / preview meter** (e.g., *"Joint model preview"* beside the canonical Balonce Meter on Tools and the ELO page), keeping the primary meter synchronized with the visible ratings until Stage 2 promotes both the meter and the ladders atomically.
* **Option B (If Primary Meter Switches at Stage 1):** Explicitly render an inline badge and tooltip on the Outcome card and Tools stating *"Win probability uses the joint commanding-and-fighting model; ladder bands remain on canonical VTSR until Stage 2 validation completes,"* and compute `mainReason()` strictly from the joint model's own terms.

### 2.3 Trap 3: Clarify "Freeze the Settings Grid" vs. "Freeze One Configuration"

**The Problem:**  
Todo #4 states: *"Freeze the structure above, the settings grid (damage loading $0.12$ to $0.16$, correlation $0$ and $0.3$, decay off and $365$ days) and the promote rule before counting a confirmation duel."*

**Why This Must Be Unambiguous:**  
Evaluating $12$ grid cells simultaneously across the $100\text{--}400$ confirmation duels and promoting whichever cell clears the threshold invalidates the $2.2\text{ SE}$ sequential testing calibration and reintroduces post-selection bias.

**Required Clarification in `joint-skill-model.md`:**  
State explicitly that the grid is swept **strictly on pre-freeze historical data** (the $800$-game corpus up to the freeze date) to select **one single frozen configuration** (or at most two pre-designated variants—e.g., static vs. $365$-day decay—with an explicit Bonferroni/simulation adjustment to the sequential boundary if both are tested prospectively). Zero hyperparameter selection may occur on confirmation duels.

### 2.4 Trap 4: Four Missing Spec Details That Will Bite During Implementation

Lock all four of these into `critique/decisions/joint-skill-model.md` before writing `joint-model-forensic`:

1. **Unbundled $(C_{\text{macro}}, F)$ Export for JS Parity:**  
   The proposal defines `displayed VTSR-C = C + own fighting share`, while the match win logit is:

   $$
   \text{logit } P(A \text{ wins}) = (C_{c_A} - C_{c_B}) + \left(\frac{1}{n_A}\sum_{i \in A} F_i - \frac{1}{n_B}\sum_{j \in B} F_j\right) + \text{matchup terms}
   $$

   Because a commander's `own fighting share` inside the team mean is $F_c / n$ ($1/3$ in $3\text{v}3$, $1/4$ in $4\text{v}4$, $1/5$ in $5\text{v}5$), `displayed VTSR-C` must pick one canonical reference size for the leaderboard (e.g., $n_{\text{ref}} = 5$, so $\text{VTSR-C}_{\text{display}} = C + \frac{1}{5} F$, or the corpus mean $\bar{n}$). Crucially, the JSON must also export raw `c_macro` (and `f_skill`) so `js/balonce-meter.js` and the Python-to-JS parity gate compute the exact team-size-aware logit without double-counting $F_c$.
2. **Zero-Damage Commander Rows (`enemy_dealt == 0`):**  
   Per `DATA_DICTIONARY.md` $\S 10.2$, `is_zero_damage` intentionally never flags commanders, so a pure-macro commander who never fires can have `enemy_dealt == 0`. Because $\log(0) = -\infty$, define the rule explicitly: **omit the damage observation** for any row with `enemy_dealt == 0` (leaving the match's win/loss likelihood term intact) rather than injecting an arbitrary $\epsilon$ that creates extreme negative log-ratio outliers.
3. **Uneven Teams, Excluded Rows, and `match.bench`:**  
   Specify exact handling for three real-world lobby cases:
   * **True uneven lobbies (e.g., $4\text{v}5$) or early disconnects (`is_low_activity`):** Taking `mean F over A's fighters` treats a $4$-player side as having no headcount disadvantage. Mirror how `Tools` $\to$ `Team Balonce` already scores odd lobbies (filling the missing seat with a floor-rated thug, or adding an explicit headcount-deficit covariate $\gamma_{\text{man}} (n_A - n_B)$).
   * **Excluded thug rows (`is_campod`, `is_low_activity`, `is_zero_damage`):** Omit from the damage-ratio likelihood; specify clearly whether an `is_low_activity` or `is_zero_damage` thug still enters the win/loss roster mean (e.g., omitted if `is_campod`, included or discounted if `is_low_activity`).
   * **Terminal bench (`match.schema_version` $31$, `match.bench` / `bench_prefix`):** Specify whether the benched player's own-team log-ratio uses `bench_prefix` (for the benched player only, matching current `scripts/elo.py`) or is omitted from the damage observation.
4. **Preventing Phantom Deltas in Walk-Forward History UI:**  
   Because a batch refit moves non-participants slightly ($\approx 0.3$ pts/game, up to $7.6$ pts), `history[m].after` for a player's previous match will occasionally differ by a few points from `history[m+k].before` on their next match (and from `elo_current`). Document as a strict frontend contract that every per-match `delta` badge and sparkline must read `after - before` from the match's own `elo_history` delta row—never `current - last_match.after`—so players never see phantom gains or losses on nights they did not play.

## 3. Recommendations on the Four "Still Open" Decisions

| Open Decision | Recommendation | Engineering & Statistical Rationale |
|---|---|---|
| **1. Responsiveness (Static vs. $365$-day decay)** | **Test both in the forensic run; lean toward $365$-day decay.** | Static's $\approx 3$ pts/game move interacts harshly with the sticky $20$-point band buffer (`scripts/vtsr_bands.py`): a player who genuinely improves needs $\sim 7$ consecutive strong games just to move one half-band. Paying $0.0015$ log-loss (statistically indistinguishable from zero) for $365$-day decay keeps bands alive over a multi-year corpus without hurting prediction. |
| **2. `numpy` in the rating scripts** | **Add `numpy` to `scripts/requirements.txt`.** | Fitting $800$ games *once* in pure Python is fine, but generating walk-forward `elo_history` requires $300\text{--}800$ sequential Newton fits. With warm-started `numpy.linalg.solve` / Cholesky factorization on a $\sim 120 \times 120$ Hessian, the entire $800$-match walk-forward history finishes in $\sim 2\text{--}3$ seconds (vs. minutes in pure Python). `numpy` is already an operator dependency for `scripts/map_match_video.py`, so it adds zero practical friction. |
| **3. Draft capture (`data/match_drafts.json`)** | **Use live-lobby polling as a convenience pre-fill, with 1-click operator confirm/edit.** | Even if captains pick one at a time in the lobby, BZCC players frequently swap slots mid-lobby to claim commander seats (`1`/`6`) or correct misclicks. Auto-polling lobby swaps into the Tools UI removes typing friction, while requiring a 1-click confirm/edit before saving prevents corrupted pick histories. |
| **4. Six-name sanity check** | **Run blind with $2\text{--}3$ veteran players.** | Ask regulars *without showing numbers* whether `blue`, `M.S`, and `Cyber` feel more impactful than their scoreboard damage suggests, and whether `Nomad`, `dd`, and `sponge` feel less impactful. Keep in mind your own note that all six gaps sit within $\sim 2\text{ SE}$—if regulars agree, it supports real unmeasured target judgment/comms; if they disagree, it confirms those residuals are ordinary small-$n$ win variance. |

## 4. Pre-Memo Readiness Checklist for `joint-skill-model.md`

Before starting confirmation duel #1, verify that `critique/decisions/joint-skill-model.md` explicitly locks all seven items below:

- [ ] **Exact Damage NLL:** Uses de-projected per-player noise $\sigma_{0,k} = \hat{s}_k / \sqrt{(k-1)/k}$ in the thug sum and orthogonal commander observation variance $\sigma_{\text{cmdr\_obs}, k}^2 = \sigma_{\text{cmdr}}^2 + \sigma_{0,k}^2 / k$.
- [ ] **Single Frozen Configuration:** Collapses the hyperparameter grid (`beta`, `rho`, `tau`) to one frozen configuration on historical data prior to the confirmation start date (no grid-shopping during confirmation).
- [ ] **Stage 1 UI Consistency Rule:** Defines whether Stage 1 ($100$ duels) displays as a preview badge alongside canonical or replaces the primary meter with an explicit split-rating disclaimer.
- [ ] **Canonical Reference Size for Displayed `VTSR-C`:** Fixes $n_{\text{ref}}$ for `displayed VTSR-C = C + (1/n_ref) * F` and exports raw `c_macro` + `f_skill` for exact Python $\leftrightarrow$ JS parity.
- [ ] **Edge-Case Rules:** Explicitly specifies `enemy_dealt == 0` commanders (omit damage row), uneven lobbies / `is_low_activity` headcount handling, and `match.bench` handling.
- [ ] **Determinism & Warm-Start Tolerance:** Specifies Newton stopping tolerance (e.g., $\|\nabla \ell\|_\infty < 10^{-9}$) so warm-started walk-forward fits match cold-started fits to machine precision across machines.
- [ ] **Phase 6 Closure:** Appends the $74$-duel `HOLD` to `critique/decisions/phase-6-faction-advantage-term.md` first so matchup terms start cleanly at zero.