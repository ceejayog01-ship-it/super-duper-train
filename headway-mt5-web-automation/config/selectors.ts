/**
 * Centralized selectors for Headway MT5 Web Terminal
 * Multiple strategies per element so the code can fall back when the UI changes.
 * Update ONLY this file when MetaQuotes/Headway changes the page.
 */

export const Selectors = {
  // ---------- Login page ----------
  login: {
    // Primary: placeholder text (very stable from your screenshot)
    loginInput: [
      'input[placeholder="Enter Login"]',
      'input[placeholder*="Enter Login" i]',
      'input[autocomplete="username"]',
      'input[name*="login" i]',
      'input[id*="login" i]', 
      'input[placeholder*="Login" i]',
      'input[type="text"]',
      '[role="textbox"][name*="login" i]',
    ],
    passwordInput: [
      'input[placeholder="Enter Password"]',
      'input[placeholder*="Enter Password" i]',
      'input[autocomplete="current-password"]',
      'input[name*="password" i]',
      'input[id*="password" i]', 
      'input[placeholder*="Password" i]',
      'input[type="password"]',
    ],
    savePasswordCheckbox: [
      'input[type="checkbox"]',
      'label:has-text("Save password") input',
      '[role="checkbox"]',
    ],
    connectButton: [
      'button:has-text("Connect to account")',
      'input[type="submit"]',
      'button[type="submit"]', 
      'button:has-text("Connect")',
      'button.green, button[style*="green"]',
      '[role="button"]:has-text("Connect")',
    ],

  },

  // ---------- Post-login / Trading UI ----------
  trading: {
    // Top bar SELL / volume / BUY (from second screenshot)
    sellButton: [
      'button:has-text("SELL")',
      '[class*="sell"]',
      'div:has-text("SELL")',
    ],
    buyButton: [
      'button:has-text("BUY")',
      '[class*="buy"]',
      'div:has-text("BUY")',
    ],
    volumeInput: [
      'input[type="number"]',
      'input[value="0.01"]',
      '[class*="volume"] input',
      'div:has-text("0.01")',
    ],
    // Bottom navigation
    tradeTab: [
      'text=Trade',
      '[role="tab"]:has-text("Trade")',
      'button:has-text("Trade")',
    ],
    quotesTab: [
      'text=Quotes',
      '[role="tab"]:has-text("Quotes")',
    ],
    chartTab: [
      'text=Chart',
      '[role="tab"]:has-text("Chart")',
    ],
  },

  // ---------- Order ticket (UNVERIFIED against the live terminal: adjust here from the dry-run screenshots) ----------
  order: {
    volumeInput: [
      'input[name*="volume" i]',
      '[class*="volume" i] input',
      'xpath=//*[normalize-space(text())="Volume"]/following::input[1]',
    ],
    stopLossInput: [
      'input[name*="sl" i]',
      'input[name*="stop" i]',
      '[class*="sl" i] input',
      '[class*="stop" i] input',
      'xpath=//*[normalize-space(text())="Stop Loss" or normalize-space(text())="S/L" or normalize-space(text())="SL"]/following::input[1]',
    ],
    takeProfitInput: [
      'input[name*="tp" i]',
      'input[name*="take" i]',
      '[class*="tp" i] input',
      'xpath=//*[normalize-space(text())="Take Profit" or normalize-space(text())="T/P" or normalize-space(text())="TP"]/following::input[1]',
    ],
    buy: [
      'button:has-text("Buy by Market")',
      'button:has-text("Buy")',
      '[class*="buy" i][role="button"]',
    ],
    sell: [
      'button:has-text("Sell by Market")',
      'button:has-text("Sell")',
      '[class*="sell" i][role="button"]',
    ],
    closeMenuItem: [
      'text=/Close (Position|Order)/i',
      '[role="menuitem"]:has-text("Close")',
    ],
    closeConfirm: [
      'button:has-text("Close")',
      'button:has-text("Yes")',
      'button:has-text("OK")',
    ],
  },

  // ---------- Generic helpers ----------
  common: {
    loadingSpinner: [
      '[class*="loading"]',
      '[class*="spinner"]',
      'text=Verifying',
      'text=Loading',
    ],
    errorMessage: [
      '[class*="error"]',
      'text=/invalid|failed|error|denied/i',
    ],
  },
} as const;

export type SelectorGroup = typeof Selectors;
