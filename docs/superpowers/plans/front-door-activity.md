# Front door: activity log

What was done on 2026-11-15 to make context-hub quicker to understand and
start, in the order it happened. The design is
[`specs/2026-11-15-context-hub-front-door-design.md`](../specs/2026-11-15-context-hub-front-door-design.md),
the plan is [`2026-11-15-context-hub-front-door.md`](2026-11-15-context-hub-front-door.md),
and where the build differed is in [`front-door-deviations.md`](front-door-deviations.md).

## 1. Audit

The owner's impression of the GitHub README was "overwhelmed", and the goal
was a quick setup whether you self-host or use the reference hub.

| Finding | Detail |
|---|---|
| The hub is single-tenant | No accounts and no per-user data. Anyone given a code reads everything, so the reference hub cannot take other people yet. |
| The README was a manual | 494 lines. The first screen explained three parts and two kinds of code; the one-line install was at line 99. No picture of the product. |
| Two code types leaked into onboarding | "Computer code" and "sign-in code" were explained three times. |
| Self-hosting needed your own image | The deploy template pointed at `ghcr.io/your-name/...` and the public image refused anonymous pulls. |
| The hub's address gave a visitor nothing | `/` redirected to a bare sign-in box. |

## 2. Decisions

- **Launch on self-hosting; the hosted hub is a waitlist.** Multi-user hosting
  is a separate, larger project. The waitlist measures whether it is worth
  building.
- **The landing page is served by the hub itself**, at `/` for signed-out
  visitors, and only when `LANDING=on`. A self-hoster's private hub keeps its
  plain sign-in screen and never collects emails.
- **The waitlist stays inside the hub.** Addresses go into the hub's own
  database. No mailing-list provider, no confirmation email, no script on the
  page.
- **What a waitlist email can offer:** nothing to sign in with until
  multi-user exists. A code today would open the owner's own data.

## 3. What was built

Pull request [#34](https://github.com/abdulmuhg/context-hub/pull/34), merged
to `main`.

| Part | Result |
|---|---|
| README | 80 lines: pitch, example, how it works, quick start, links. The reference text moved to `docs/using.md` and `docs/self-hosting.md`. |
| Self-host | Three commands. CI also pushes `latest` and a dated tag; the compose file defaults to the public image and takes the address from `HUB_DOMAIN`. |
| First codes | `hub-admin setup` prints the dashboard sign-in code and the install lines for the first computer. The image has a `hub-admin` shim. |
| Landing page | Hero, example, how it works, privacy points, the self-host commands, the waitlist form. |
| Waitlist | `POST /waitlist`, a `waitlist` table (migration 14, at most 10,000 addresses), `hub-admin waitlist`, `hub-admin waitlist remove <email>`, and a count on the Overview. |

How the work was done: the plan was executed by a separate session in its own
worktree, one commit per task, then reviewed against the plan.

## 4. What review found

- **A broken `Dockerfile` line.** The `hub-admin` shim was written with real
  line breaks inside a `RUN`, which Docker cannot parse. Fixed before the pull
  request; the deploy that followed the merge built it.
- **A merge conflict with `main`.** PostHog pageviews had landed meanwhile.
  Both the `landing` setting and the `pageview` capture were kept, and the two
  `POSTHOG_*` settings rows moved into `docs/self-hosting.md`.

## 5. Rollout

1. #34 merged; the deploy built and passed its verification.
2. #31 (a minor `posthog-node` bump) merged and deployed.
3. `LANDING=on` set in the reference hub's settings on the server and the
   container recreated. Checked afterwards: `/` answers the landing page, its
   stylesheet loads, the sign-in page links back to it, a bad address on the
   form answers 400 and a cross-origin post answers 403.

Three dependency pull requests were left open on purpose, because CI runs only
typecheck and tests on Node 22 and does not build the image: `tsup` 8 to 9
(#33), `@anthropic-ai/sdk` 0.133 to 1.8 (#32), and the Docker base image
`node:22-slim` to `26-slim` (#30).

## 6. Not verified

- **How the landing page looks.** It was checked by measuring the layout, not
  by eye, and only in the dark theme.
- **The README screenshot** was not added.

## 7. Still open

For the owner, outside this repository:

- Make the GHCR package public. Until then the three-command quick start fails
  at the image pull.
- Record `LANDING=on` in the deployment repository's settings template, so a
  rebuild of the server keeps it.
- Point the GitHub repository's website field at the hub.

Known and left as is:

- With `POSTHOG_KEY` set, signed-out visits to the landing page are counted.
  It is server-side only; there is no script on the page.

Next work is in
[`2026-11-15-context-hub-front-door-followup.md`](2026-11-15-context-hub-front-door-followup.md).
