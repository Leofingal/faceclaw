/**
 * The handful of globals the test build needs declared.
 *
 * `tests/tsconfig.json` compiles with `"types": []` and `"lib": ["ES2020"]` —
 * deliberately, so a module that quietly reaches for a DOM or Node API cannot
 * pass this build and then fail on the glasses. The cost is that `console`,
 * which every platform this code runs on really does have, is undeclared.
 *
 * It first bit when the home screen's app-run painter was split out for
 * headless rendering: that pulled `graphics/icons.ts` into the test build for
 * the first time, and its one `console.warn` failed the compile — along with
 * the warnings in `util/aligned-tick.ts` and `apps/exocortex/app-run.ts` that
 * report a status provider throwing.
 *
 * Declared as narrowly as the code uses it, rather than by adding "DOM" to
 * `lib`: DOM would also declare `fetch`, `setTimeout` and the rest of the
 * browser surface, which is exactly the class of mistake the empty `types`
 * list exists to catch.
 */
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
