/**
 * How far the running app has fallen behind the token lists on `main`.
 *
 * The weekly refresh keeps the **repository** current. It cannot keep the **running
 * app** current: the lists are compiled into the build (`config/chains.ts` imports the
 * JSON), the build happens on a developer machine, and the target is reachable only
 * over Tailscale — which GitHub's runners are not on (ADR-018). So a refresh that
 * lands on `main` changes nothing about what a browser sees until someone deploys.
 *
 * That gap was missed when M2-5(b) shipped, and it mattered: the automation was
 * described as closing the maintenance debt while only half of it was closed. This
 * module is the honest version — it cannot deploy, so it makes the shortfall visible
 * and specific instead of leaving it to be noticed.
 *
 * **What it compares.** Not commits — the age of the `generatedAt` in the lists the
 * live app is actually serving, because that is the same quantity the app's own 60-day
 * warning measures. A count of commits behind would be noise; "the running site is
 * using lists from six weeks ago" is a decision.
 */

/**
 * Past this, the shortfall is worth interrupting someone about.
 *
 * Half of the app's own 60-day threshold (`tokenListMaxAgeDays`), so the prompt
 * arrives with a month of slack before the live site starts telling *users* its lists
 * are aged. Weekly nagging was the thing to avoid — a refresh lands most Mondays, so
 * a "there is something to ship" notice every week would be ignored within a month,
 * which is how the previous always-ask design failed.
 */
export const DEPLOY_LAG_WARN_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * @typedef {Object} DeployLag
 * @property {'unknown' | 'current' | 'pending' | 'behind'} status
 * @property {number | null} deployedAgeDays
 * @property {boolean} hasSomethingToShip
 * @property {string} summary
 */

/**
 * Classifies the gap between what is deployed and what is on `main`.
 *
 * `unknown` is a real answer, not a fallback: before any deploy has recorded itself
 * there is nothing to compare, and guessing "probably fine" would be the same species
 * of dishonesty as a fresh timestamp on a shrunken list.
 *
 * @param {{ deployedGeneratedAt: string | null, mainGeneratedAt: string, now: number }} input
 * @returns {DeployLag}
 */
export function assessDeployLag(input) {
  const mainAt = Date.parse(input.mainGeneratedAt);

  if (input.deployedGeneratedAt === null) {
    return {
      status: 'unknown',
      deployedAgeDays: null,
      hasSomethingToShip: false,
      summary:
        'No deploy has recorded itself yet, so what the live site is serving is unknown. ' +
        'The next `pnpm deploy` records it, and this becomes a real comparison.',
    };
  }

  const deployedAt = Date.parse(input.deployedGeneratedAt);
  if (Number.isNaN(deployedAt) || Number.isNaN(mainAt)) {
    return {
      status: 'unknown',
      deployedAgeDays: null,
      hasSomethingToShip: false,
      summary: 'A `generatedAt` could not be parsed, so the comparison would be a guess.',
    };
  }

  // Floored to whole days, matching how the app's own age warning rounds, so the two
  // never disagree about what day it is.
  const deployedAgeDays = Math.floor((input.now - deployedAt) / MS_PER_DAY);
  const hasSomethingToShip = deployedAt < mainAt;

  if (!hasSomethingToShip) {
    return {
      status: 'current',
      deployedAgeDays,
      hasSomethingToShip,
      summary: `The live site is serving the same lists as \`main\` (${describeAge(deployedAgeDays)}). Nothing to ship.`,
    };
  }

  if (deployedAgeDays > DEPLOY_LAG_WARN_DAYS) {
    return {
      status: 'behind',
      deployedAgeDays,
      hasSomethingToShip,
      summary:
        `**The live site is serving token lists ${describeAge(deployedAgeDays)}**, and ` +
        `\`main\` has newer ones. Past ${DEPLOY_LAG_WARN_DAYS} days this is worth acting on: ` +
        'a browser is being told about coverage that has since been refreshed.',
    };
  }

  return {
    status: 'pending',
    deployedAgeDays,
    hasSomethingToShip,
    summary:
      `\`main\` has newer lists than the live site, which is serving lists ` +
      `${describeAge(deployedAgeDays)}. Still well inside ${DEPLOY_LAG_WARN_DAYS} days, so ` +
      'this is a note rather than a task.',
  };
}

/** The one instruction that resolves a `behind` status. */
export function deployInstruction() {
  return 'NUXFOLIO_DEPLOY_TARGET=<user@host> pnpm deploy';
}

/** @param {number} days */
function describeAge(days) {
  if (days <= 0) {
    return 'generated today';
  }
  return `generated ${days} day${days === 1 ? '' : 's'} ago`;
}
