# Peer Review v3: Final Pre-Memo Feedback on the `VTSR next-gen analysis` Plan

**Audience:** Claude / `vt-stats` rating-system developer

**Context:** Third-pass review of the `2026-11-22` revised `VTSR next-gen analysis` plan (incorporating Peer Review v2, the net-versus-dealt study, the team-strength/end-game study, and the new game-mechanics reference).

**Purpose:** Resolve four final technical traps—including two mathematical bugs introduced by the switch to Student-$t$ noise—tighten the sequential switch rule, and settle the low-tier lift call before `critique/decisions/joint-skill-model.md` is frozen.

## 1. Executive Verdict: Nearly Memo-Ready

This third revision resolves every major structural issue from the earlier drafts:

* **Exact Centered Likelihood Snapped Into Place:** Fixing the centered log-ratio variance ($\sigma_k = \hat{s}_k / \sqrt{(k-1)/k} \approx 0.29, 0.34, 0.37$) immediately rendered the ad-hoc half-weight unnecessary ($0.6119$ vs. $0.6120$ log-loss). When removing a bug eliminates an empirical fudge factor, the underlying model specification is right.
* **Split-Brain UI Risk Eliminated:** Discovering that the joint model differs from today's meter by $\ge 10$ percentage points in $56\%$ of $252$ recorded duels—and flips the favorite in $20\%$—fully vindicates converting Stage 1 into a labelled preview and switching the meter, `VTSR-T` bands, and `VTSR-C` atomically only when the switch rule passes.
* **Clean Experimental Discipline:** Freezing one single configuration via a committed script before confirmation duel #1 protects the $2.2\text{ SE}$ sequential false-pass rate.
* **Grounded Domain Reference:** Adding the *"How the game works"* section (sourced cleanly across ODFs, empirical data, and operator confirmation) gives the repository a durable mechanics reference so future analyses stop hallucinating non-BZCC mechanics.

Before freezing `critique/decisions/joint-skill-model.md` and implementing `joint-model-forensic`, fix the **four remaining technical traps** below.

## 2. Four Technical Traps to Resolve Before Freezing the Memo

### 2.1 Trap 1: Two Mathematical Bugs in the New Student-$t$ ($\nu = 5$) Damage Likelihood

Replacing Gaussian damage noise with Student-$t$ ($\nu = 5$) noise to protect against outlier games introduces two subtle defects that were absent in the Gaussian specification:

#### Defect A: Loss of Convexity & Broken Newton / Laplace Guarantees

The Student-$t$ negative log-likelihood for residual $r$ and scale $\sigma$ is:

$$
\ell_t(r) = \frac{\nu + 1}{2} \ln\left(1 + \frac{r^2}{\nu \sigma^2}\right)
$$

Its second derivative with respect to $r$ is:

$$
\frac{d^2 \ell_t}{dr^2} = (\nu + 1)\frac{\nu \sigma^2 - r^2}{\left(\nu \sigma^2 + r^2\right)^2}
$$

Whenever $|r| > \sqrt{\nu}\,\sigma$ (for $\nu = 5$, $|r| > 2.236\,\sigma$), **the second derivative turns strictly negative**. Because your own diagnostics note $10$ rows sitting below $-2.0$ on the log-ratio, the damage term contributes negative curvature to the Hessian:

1. **Undamped Newton steps can move uphill or fail to converge** if the full Hessian loses positive-definiteness.
2. **Global uniqueness is lost:** Warm-started walk-forward fits and cold-started fits are no longer guaranteed to converge to the same optimum.
3. **Laplace uncertainties become unreliable:** Reading player uncertainties from the inverse Hessian $H(\hat{\theta})^{-1}$ at the fitted mode is only well-behaved when the objective is locally strongly convex; outlier rows can shrink curvature and inflate or distort uncertainty intervals.

#### Defect B: Pre-Centering on the Arithmetic Mean Lets One Outlier Contaminate Teammates

In the proposal, you first center each thug's log-damage on the ordinary arithmetic team mean $\bar{y} = \frac{1}{k}\sum_{j=1}^k y_j$, and *then* pass the centered residuals into a heavy-tailed loss.

Consider a $4$-thug team where three thugs deal $20{,}000$ damage ($\ln(d + 100) \approx 9.90$) and one thug has a disaster game at $200$ damage ($\ln(d + 100) \approx 5.70$):

* The ordinary arithmetic team mean is $\bar{y} = (3 \times 9.90 + 5.70) / 4 = 8.85$.
* The outlier sits at $v_{\text{out}} = 5.70 - 8.85 = -3.15$, where the Student-$t$ tail downweights it (as intended).
* **However, all three normal teammates are pushed to** $v_{\text{norm}} = 9.90 - 8.85 = +1.05$—squarely inside the quadratic core of the loss! The heavy-tailed loss forgives the outlier while handing all three teammates an unearned $+1.05$ damage windfall.

#### Two Clean Fixes (Choose One Before Freezing the Memo)

* **Option A — Stay Gaussian with Length-Scaled Noise (Recommended):**
  Your own Pass 3 check showed that heavy-tailed length-scaled noise improved scoring-window log-loss over plain Gaussian noise by just $0.003 \pm 0.004$ across $252$ duels—pure noise. Staying Gaussian (while omitting `enemy_dealt == 0` commander rows and short-match damage outliers; see Trap 4) preserves:
  1. The exact closed-form centered multivariate normal likelihood ($\frac{1}{2\sigma_{0,k}^2}\sum r_i^2$).
  2. Strict global convexity and a unique global optimum (guaranteed warm/cold start equivalence).
  3. Exact positive-definite Hessians for Newton steps and Laplace uncertainties.

* **Option B — If Heavy Tails Are Kept, Use Pseudo-Huber Loss + a Team-Match Nuisance Intercept $\mu_{m,t}$:**
  Replace Student-$t$ with **Pseudo-Huber loss**, which is quadratic near zero, linear in the tails, and **strictly convex everywhere**:

  $$
  \rho_\delta(r) = \delta^2 \left(\sqrt{1 + \left(\frac{r}{\delta}\right)^2} - 1\right), \qquad \frac{d^2 \rho_\delta}{dr^2} = \left(1 + \left(\frac{r}{\delta}\right)^2\right)^{-3/2} > 0
  $$

  To prevent outlier contamination across teammates, do **not** pre-subtract the arithmetic mean. Instead, include one scalar nuisance intercept $\mu_{m,t}$ per team-match directly inside the convex objective:

  $$
  \mathcal{L}_{\text{team}} = \sum_{i=1}^k \rho_\delta\left(\frac{\ln(d_i + 100) - \mu_{m,t} - \beta F_i}{\sigma_{0,k}}\right)
  $$

  (Under Gaussian loss, profiling out $\mu_{m,t}$ algebraically recovers the exact centered likelihood; under Pseudo-Huber loss, $\mu_{m,t}$ automatically acts as a robust M-estimator center so a single outlier cannot push its teammates upward. Because $\mu_{m,t}$ is block-diagonal across matches, it can be eliminated cleanly via Schur complement in each Newton step.)

### 2.2 Trap 2: Three Loose Ends in the Sequential Switch Rule

The sequential validation framework (looks every $60$ recorded duels up to $400$ at $2.2\text{ SE}$) is statistically sound, but three edge conditions must be written down with zero ambiguity in `critique/decisions/joint-skill-model.md`:

1. **Exact Pass Inequality:**
   Specify explicitly whether passing at look $n \in \{60, 120, 180, 240, 300, 360, 400\}$ requires **both** a point-estimate improvement of at least $0.010$ **and** $2.2\text{ SE}$ separation from zero:

   $$
   \Delta \text{LL} = \text{LL}_{\text{joint}} - \text{LL}_{\text{base}} \le -0.010 \quad \text{AND} \quad \frac{\Delta \text{LL}}{\text{SE}_{\text{paired}}(\Delta \text{LL})} \le -2.2
   $$

   (Confirm this exact pair matches your $39\%\text{--}70\%$ power simulation, as opposed to requiring $2.2\text{ SE}$ *beyond* $-0.010$.)

2. **Numeric Tolerance on "Calibration Is No Worse":**
   Define the exact calibration metric (e.g., binned calibration MAE or Brier reliability) and include a small noise tolerance—such as $\text{Cal}_{\text{joint}} \le \text{Cal}_{\text{base}} + 0.005$—or require strictly lower paired Brier score. Without a tolerance, a meaningless $0.0002$ binning wiggle could veto a decisive $-0.030$ log-loss win.

3. **Hard Terminal Stop at $400$ Duels:**
   State explicitly that if the switch rule has not passed by duel $400$, the experiment terminates cleanly as `HOLD / RETIRE` (no extending to $500$ or $600$ duels). Otherwise, optional stopping breaks the $5\%$ Type-I error guarantee.

### 2.3 Trap 3: Operationalizing "Baseline Named by Commit" Across the Interim VTSR-T Revision

Your Pass 3 re-rates confirmed an important trade-off: the interim VTSR-T revision (opponents-only reference + $180\text{s}$ late-demolition trim) improves personal fairness cleanly, but lowers win-prediction power slightly (thug-gap likelihood gain $4.87 \to 3.37$; forward winner AUC $0.610 \to 0.602$).

Pinning the joint model's switch-rule baseline *by commit* is the right safeguard—otherwise the interim re-rate would weaken the canonical benchmark mid-test and hand the joint model an unearned handicap. However, spell out **how the validator computes that pinned baseline in code** once the interim VTSR-T revision merges to `main`:

* **Option A — Shadow Replay of Pre-Interim Baseline:** Have `scripts/validate_elo.py` run a self-contained copy of the pre-interim `elo.py` + `elo_commander.py` parameters in memory over confirmation duels so the joint model is always judged against the exact frozen pre-interim yardstick.
* **Option B — Ship Interim VTSR-T First, Then Freeze (Operationally Simpler):** Because the interim revision only requires one hook, one harness, and one memo, shipping it first—and *then* freezing `joint-skill-model.md` against the live post-interim canonical ladder—eliminates the need to maintain a parallel legacy replay inside `validate_elo.py` for $3\text{--}5$ months, at the cost of only a week or two on the confirmation clock.

Choose Option A or Option B explicitly in the memo before duel #1 is counted.

### 2.4 Trap 4: Short-Match Edge Case Under $\ln(d_i + 100)$

Per `DATA_DICTIONARY.md` $\S 11$, `ELO_SCHEMA_VERSION` $20$ dropped the $240\text{s}$ match-length floor (`min_duration_sec = 0`), so $2\text{--}4\text{-minute}$ rushes now rate. In a $3$-minute rush, a single early death can leave a thug at $300\text{--}600$ enemy damage while a teammate deals $4{,}000$, making $\ln(d_i + 100)$ volatile and sensitive to the $+100$ additive constant.

Add an explicit short-match rule to `joint-skill-model.md`:

* Either **omit the damage observation** (while still scoring the match's win/loss outcome) whenever `duration_sec < 240`, **or** cap the minimum length fed into the length-scaled noise function so short rushes receive appropriately high observation variance. Omitting damage rows under $240\text{s}$ is cleaner and prevents $3$-minute rush noise from distorting fighting skill.

## 3. Clear Calls on the Remaining Open Decisions

### 3.1 Retire the Low-Tier Lift (`v2.8`) Inside the Interim VTSR-T Revision

Do **not** wait for the joint model to retire `v2.8`. Your Pass 3 re-rate exposed a severe threshold-feedback defect:

* Switching `scripts/elo.py` to an opponents-only reference lowers `judgeguns` cleanly by $-52$ points when the lift is off.
* With the lift on, that $-52\text{-point}$ drop pushes him below `LOWTIER_LIFT_CUTOFF = 1460`, flipping his `lowtier_lift_factor` from $0.00 \to 0.59$ and swinging him all the way to $+64$—a **$116\text{-point}$ non-monotonic inversion** caused purely by crossing a cliff.
* Combined with Pass 2's ablation (turning `v2.8` off improved all three validity checks: $\rho$ $0.449$ vs. $0.433$, thug-gap calls $56.5\%$ vs. $55.6\%$, likelihood gain $5.56$ vs. $5.35$), shipping an interim fairness revision while keeping `v2.8` active introduces a larger distortion than the one it fixes. Include retiring `v2.8` in the interim VTSR-T memo's on/off evaluation and drop it during the single interim re-rate.

### 3.2 Engineering Sign-Offs (No Changes Needed)

* **`numpy` Soft-Fail Module:** Placing the joint solver in its own module with a soft-fail import block (matching `elo_1v1.py` / `elo_2v2.py`), keeping existing canonical scripts stdlib-only, and comparing joint outputs with a numerical tolerance rather than a byte hash is clean software engineering.
* **No Time Decay:** Your Pass 3 check proved $365$-day decay adds only $+0.6$ points of per-game movement ($3.7 \to 4.3$) while costing out-of-sample log-loss ($0.5908 \to 0.5936$). Keeping the frozen configuration static—and generating per-game *"Beat expectation / On par / Below expectation"* verdicts directly from that match's own damage residual—solves responsiveness cleanly without sacrificing accuracy.
* **Six-Name Blind Check (`blue`, `M.S`, `Cyber` vs. `Nomad`, `dd`, `sponge`):** Keep this purely qualitative once the forensic output is generated; do not alter frozen parameters based on it.
* **"Not Verified" Mechanics List:** None of the four items block modeling. (For the doc's completeness: in standard VSR strat, the Recycler typically spawns mobile and deploys after driving out—consistent with the $\sim 35\text{s}$ median to first scavenger—and standard victory is Recycler + Factory loss unless overridden by lobby `svar` settings.)

## 4. Final Pre-Freeze Checklist for `critique/decisions/joint-skill-model.md`

Before counting confirmation duel #1, verify all six items are explicitly locked in the memo:

* [ ] **Convex Damage Loss Selected:** Either Gaussian (recommended; length-scaled noise, exact centered NLL) or strictly convex Pseudo-Huber with a per-team-match nuisance intercept $\mu_{m,t}$ (not Student-$t$ on pre-centered means).
* [ ] **Short-Match Rule Locked:** Explicit rule for `duration_sec < 240` under $\ln(d_i + 100)$ (recommend omitting damage observations under $240\text{s}$ while keeping win/loss outcomes).
* [ ] **Exact Switch-Rule Inequalities:** Both $\Delta \text{LL} \le -0.010$ and $\Delta \text{LL} / \text{SE} \le -2.2$, explicit numeric tolerance on calibration, and a hard stop at duel $400$.
* [ ] **Pinned Baseline Mechanics Specified:** Either shadow-replay pre-interim `elo.py` + `elo_commander.py` in `validate_elo.py`, or land the interim VTSR-T re-rate first and freeze the post-interim ladder as the clean baseline.
* [ ] **Zero-Damage & Excluded-Row Rules:** Exact treatment of `enemy_dealt == 0` commanders, `is_campod` / `is_low_activity` / `is_zero_damage` thugs, `match.bench`, and uneven sides.
* [ ] **Low-Tier Lift Retirement Evaluated in Interim Memo:** Explicit decision to retire `v2.8` during the interim VTSR-T re-rate to prevent the $116\text{-point}$ `judgeguns` cliff inversion.