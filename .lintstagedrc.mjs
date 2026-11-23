/**
 * Runs on the staged files before every commit (.husky/pre-commit): ESLint (with type information) for TypeScript,
 * then Prettier for everything it formats. The type check of the whole project runs separately in the hook: a change
 * in one file can break types in another that is not staged.
 */
const quote = (files) => files.map((file) => JSON.stringify(file)).join(" ");

export default {
  "*.{ts,js,mjs}": (files) => [
    `eslint --max-warnings=0 ${quote(files)}`,
    `prettier --write --ignore-unknown ${quote(files)}`,
  ],
  "*.{json,jsonc,md,yml,yaml}": (files) => `prettier --write --ignore-unknown ${quote(files)}`,
};
