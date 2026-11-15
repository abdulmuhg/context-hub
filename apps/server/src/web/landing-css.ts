// The landing page's stylesheet. It only uses the custom properties app.css already defines,
// so both themes work with no new colours. Served at /assets/landing.css.
export const LANDING_CSS = `/* context-hub landing page */
.landing { max-width: 760px; margin: 0 auto; padding: 0 16px 48px; font-size: 15px; }
.landing h1 { font-size: 34px; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 16px; }
.landing h2 { font-size: 20px; margin: 0 0 12px; }
.landing section { padding: 32px 0; border-top: 1px solid var(--hairline); }
.landing .lede { font-size: 17px; color: var(--muted); margin: 0 0 24px; }
.landing-bar { display: flex; align-items: center; gap: 16px; padding: 16px 0; flex-wrap: wrap; }
.landing-brand { font-weight: 600; font-size: 16px; letter-spacing: -0.01em; text-decoration: none; margin-right: auto; }
.landing-bar a:not(.landing-brand) { color: var(--muted); font-weight: 500; text-decoration: none; }
.landing-bar a:not(.landing-brand):hover { color: var(--ink); }
.landing .landing-hero { padding: 40px 0 32px; border-top: 0; }
.landing .landing-hero.landing-thanks { border-top: 1px solid var(--hairline); }
.landing-buttons { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 24px; }
.landing .button {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  padding: 0 18px;
  min-height: 42px;
}
.landing .button.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.landing-example { margin: 8px 0 0; }
.landing-example .tag { margin-bottom: 8px; }
.landing-example pre {
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  margin: 0;
  overflow-x: auto;
  white-space: pre;
}
.landing-steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 16px; counter-reset: step; }
.landing-steps li { margin: 0; padding-left: 40px; position: relative; counter-increment: step; }
.landing-steps li::before {
  content: counter(step);
  position: absolute;
  left: 0;
  top: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--chip);
  text-align: center;
  line-height: 28px;
  font-weight: 600;
}
.landing-steps strong { display: block; }
.landing-steps span { color: var(--muted); }
.landing-points { padding-left: 1.2em; margin: 0; }
.landing .copyrow { margin: 0 0 8px; }
.landing .copyline { margin: 0; }
.landing form.waitlist { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; margin: 0 0 12px; }
.landing form.waitlist label { display: block; width: 100%; font-weight: 500; }
.landing form.waitlist input[type="email"] {
  flex: 1;
  min-width: 200px;
  font: inherit;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: 0 12px;
  min-height: 42px;
}
.landing [role="alert"] { color: var(--danger); }
.landing details { border-bottom: 1px solid var(--hairline); padding: 12px 0; }
.landing details:first-of-type { border-top: 1px solid var(--hairline); }
.landing summary { font-weight: 500; cursor: pointer; }
.landing details p { color: var(--muted); margin: 8px 0 0; }
.landing-footer { display: flex; flex-wrap: wrap; gap: 16px; padding-top: 24px; border-top: 1px solid var(--hairline); color: var(--muted); }
@media (max-width: 480px) {
  .landing h1 { font-size: 28px; }
}
`;
