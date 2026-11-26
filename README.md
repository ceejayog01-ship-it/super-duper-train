# Standalone Headway MT5 Demo Paired-Order Runner

This repository contains only the Headway login and order-execution automation. It does **not** include the TSE strategy engine, Yahoo Finance, candle downloads, or strategy data.

## Fixed behaviour

Each manual GitHub Actions dispatch runs this fixed sequence:

1. Log in to the Headway **demo** web terminal.
2. Check that no EURUSD position is already open.
3. Submit one EURUSD **BUY 0.50 lot** market order.
4. Continue only if the existing order routine detects the BUY leg through its margin-change check.
5. Submit one EURUSD **SELL 0.50 lot** market order.
6. Leave both positions open for the user to close manually.

There are no BUY/SELL workflow inputs, no strategy signal, no price-data provider, no automatic stop/target, and no automatic position closure. The two orders are submitted sequentially, not atomically at the exact same instant.

## Important account-mode limitation

The account must support **hedging** (holding BUY and SELL positions on the same symbol at the same time). On a netting account, the opposite SELL may reduce, close, or reverse the BUY instead of creating a separate hedge. This project cannot reliably identify the broker's account margin mode from the current web-terminal UI. Confirm the demo account is in hedging mode before dispatching.

## 1. Create the new GitHub repository

1. Create a new, empty GitHub repository.
2. Do not add a README, license, or `.gitignore` during repository creation; the installer will add the project files.
3. Upload `headway-demo-paired-orders.zip` to the repository root.
4. In GitHub, create `.github/workflows/bootstrap-install.yml` and paste the bootstrap workflow provided separately in the handoff (the same workflow is also included in the archive).
5. Open **Actions** → **Install Headway Demo Paired-Order Project** → **Run workflow**.
6. Wait for the installer to finish. It extracts the archive, commits the project, and removes the uploaded ZIP.

## 2. Add demo credentials as GitHub Secrets

In the new repository:

1. Open **Settings** → **Secrets and variables** → **Actions**.
2. Select **New repository secret**.
3. Add `MT5_LOGIN` with the numeric Headway demo account login.
4. Add `MT5_PASSWORD` with that demo account's trading password.

Do not put credentials in source files, workflow YAML, commits, or the ZIP. The workflow pins the URL to `https://hw.online/webterminal/mt5-demo/` and sets `ACCOUNT_MODE=demo`; it does not accept a real-account URL.

## 3. Run the paired demo test

1. Open **Actions**.
2. Select **Headway Demo - Open BUY and SELL (0.50 each)**.
3. Select **Run workflow**. There are no direction or execution inputs to choose.
4. Open the run and inspect its log and uploaded artifact.
5. Independently sign in to the Headway demo terminal and check the Trade/Positions tab.
6. Manually close the positions when finished.

## Safety and failure behaviour

- Fixed symbol: EURUSD.
- Fixed volume: 0.50 lots per leg (1.00 lots gross across both legs if both are open).
- Demo endpoint and demo account mode are hard-coded in the workflow.
- If an EURUSD position already exists before the run, the first leg is blocked to avoid mixing with an unmanaged position.
- The SELL leg is skipped if the BUY routine does not return `executed_confirmed`.
- The existing automation's `executed_confirmed` status is based on an account-margin change, not a guaranteed broker ticket identifier. Always verify both positions directly in the demo terminal.
- No automatic retry is performed after a click. If the outcome is uncertain, inspect the account before running again.
- The GitHub runner is temporary. Closing the browser does not close positions already accepted by the broker.

## Technical note

The automation uses Playwright against the Headway MT5 web terminal. Web-terminal selectors can change. The first run may fail at login, ticket detection, or broker confirmation if Headway changes its UI; inspect the uploaded artifact before attempting another run.
