# Nuxfolio — WSL Ubuntu Development Setup

This document describes the development environment for **Nuxfolio** on Windows
WSL with Ubuntu. It records how this specific machine was set up, including the
problems that were hit and fixed, so the same environment can be rebuilt.

For running the application itself, see [`README.md`](README.md).

## Current state

Project directory:

```text
~/GIT/CRYPTO/nuxfolio
```

Verified toolchain:

```text
Node.js: 24.18.1
npm:     11.16.0
pnpm:    11.18.0
```

Keep the project inside the WSL Linux filesystem rather than under `/mnt/c/...`.
Node.js projects are considerably faster there, because file access across the
Windows/Linux boundary is not.

The conda `(base)` environment can stay active. It does not interfere with
Node.js managed through `nvm` — see section 8.

## 1. Open the project

```bash
cd ~/GIT/CRYPTO/nuxfolio
```

## 2. Node.js through NVM

The project uses Node.js installed through `nvm`.

Check the current version:

```bash
node --version
```

Expected:

```text
v24.18.1
```

The default version was set with:

```bash
nvm alias default v24.18.1
```

`.nvmrc` contains:

```text
24.18.1
```

When reopening the project:

```bash
cd ~/GIT/CRYPTO/nuxfolio
nvm use
```

Confirm the binaries resolve to the nvm-managed installation:

```bash
which node
which npm
```

Expected paths look like:

```text
/home/nux/.nvm/versions/node/v24.18.1/bin/node
/home/nux/.nvm/versions/node/v24.18.1/bin/npm
```

## 3. Resolved conflict in `.npmrc`

The previous `~/.npmrc` contained:

```text
prefix=/home/nux/.npm-global
```

That setting is incompatible with `nvm`, because both try to control where
global npm packages live.

A backup was taken before changing it:

```text
~/.npmrc.backup
```

The conflicting line was removed and `~/.npmrc` is now empty.

If the error reappears, check for it:

```bash
cat ~/.npmrc
grep -nE '^[[:space:]]*(prefix|globalconfig)[[:space:]]*=' ~/.npmrc
```

Remove the offending lines if present:

```bash
sed -i -E '/^[[:space:]]*(prefix|globalconfig)[[:space:]]*=/d' ~/.npmrc
```

Then activate Node.js:

```bash
nvm use --delete-prefix v24.18.1
```

## 4. pnpm

`pnpm` is enabled through Corepack.

Check the version:

```bash
pnpm --version
```

Expected:

```text
11.18.0
```

Commands used:

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

Use `pnpm` for Nuxfolio. Do not mix `npm`, `yarn` and `pnpm` lock files — the
repository tracks `pnpm-lock.yaml` only, and `package.json` pins
`packageManager` to make that explicit.

Note for pnpm 11: settings such as `allowBuilds` live in `pnpm-workspace.yaml`,
not in `package.json`. Nuxfolio uses it to approve the install scripts for
`sharp` and `unrs-resolver`, which keeps installs non-interactive.

## 5. Git

The Git repository is already initialised:

```bash
git status
```

`.gitignore` covers the entries that must never be committed:

```text
node_modules/
.next/
dist/
.env
.env.local
*.log
```

`.env.example` is tracked deliberately; real secrets are not. `.gitignore`
excludes every `.env*` file and then re-includes `.env.example`, so a new
variable added to a local file cannot be committed by accident.

## 6. Project documents

```text
PROJECT_KICKOFF.md      The original brief
README.md               How to run and configure the application
docs/IMPLEMENTATION_PLAN.md
docs/DECISIONS.md
docs/PROVIDERS.md
docs/REVIEW_LOG.md
```

## 7. Running Claude Code

From the project directory:

```bash
cd ~/GIT/CRYPTO/nuxfolio
nvm use
claude
```

## 8. Conda

The conda `(base)` environment can be left as it is.

The presence of:

```text
(base)
```

in the prompt does **not** mean Node.js is coming from conda. These two commands
confirm the real environment:

```bash
which node
node --version
```

As long as `which node` points inside:

```text
/home/nux/.nvm/
```

Node.js is correctly managed by `nvm`.

If a separate Python service is added later for AI analysis, give it a dedicated
environment:

```bash
conda create -n nuxfolio-ai python=3.12 -y
conda activate nuxfolio-ai
```

That is not needed for the current milestone.

## 9. Repository structure

```text
~/GIT/CRYPTO/nuxfolio
├── .env.example
├── .gitignore
├── .nvmrc
├── .prettierignore
├── .prettierrc.json
├── NUXFOLIO_WSL_SETUP.md
├── PROJECT_KICKOFF.md
├── README.md
├── docs/
│   ├── DECISIONS.md
│   ├── IMPLEMENTATION_PLAN.md
│   ├── PROVIDERS.md
│   └── REVIEW_LOG.md
├── eslint.config.mjs
├── next.config.ts
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── postcss.config.mjs
├── scripts/
│   └── generate-token-list.mjs
├── src/
│   ├── app/
│   ├── components/
│   ├── config/
│   ├── domain/
│   ├── lib/
│   ├── providers/
│   ├── server/
│   └── test/
├── tsconfig.json
└── vitest.config.ts
```

## 10. Verifying the environment

```bash
cd ~/GIT/CRYPTO/nuxfolio
nvm use
pnpm install
pnpm verify     # format:check, lint, typecheck, test, build
pnpm dev
```

If `pnpm verify` passes, the environment is sound.
