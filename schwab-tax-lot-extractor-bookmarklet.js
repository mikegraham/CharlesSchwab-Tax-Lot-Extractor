javascript:(function() {
    'use strict';

    const taxLotData = {};
    const done = new Set();
    let failed = [];

    function log(message) {
        console.log('[Tax Lot Extractor]', message);
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /* querySelectorAll that also descends into open shadow roots */
    function deepQueryAll(selector, root = document, out = []) {
        root.querySelectorAll(selector).forEach(el => out.push(el));
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out);
        });
        return out;
    }

    function deepQuery(selector, root = document) {
        return deepQueryAll(selector, root)[0] || null;
    }

    async function waitFor(fn, timeoutMs = 10000, intervalMs = 250) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const result = fn();
            if (result) return result;
            await delay(intervalMs);
        }
        return null;
    }

    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function parseValue(text) {
        if (!text) return 0;
        const cleanText = text.replace(/[$,\s+%]/g, '');
        return parseFloat(cleanText) || 0;
    }

    function parseDate(dateStr) {
        if (!dateStr) return '';
        return dateStr.trim();
    }

    function extractSymbolFromTitle(titleText) {
        const match = titleText.match(/Lot Details:\s*([A-Z0-9.\/]+)\s*-/);
        return match ? match[1] : null;
    }

    /* Close any open popover menus (sdps-sheet uses popover="auto"). */
    async function closeMenus() {
        deepQueryAll('[popover]').forEach(el => {
            try {
                if (el.matches(':popover-open')) el.hidePopover();
            } catch (e) { /* not open or unsupported */ }
        });
        await delay(300);
    }

    /* Find the lot modal whose title names this symbol. There can be more than
       one #open-lot-overlay-modal-title in the DOM (stale or re-rendered modals). */
    function findLotModalFor(symbol, requireVisible) {
        const titles = deepQueryAll('#open-lot-overlay-modal-title');
        for (const title of titles) {
            if (extractSymbolFromTitle(title.textContent) !== symbol) continue;
            if (requireVisible && !isVisible(title)) continue;
            const modal = title.closest('sdps-modal, #open-lot-overlay') ||
                          title.getRootNode()?.host || null;
            const scope = modal || title.parentElement;
            const table = deepQuery('#responsiveLotTable', scope);
            if (table && table.querySelector('tbody tr.data-row')) {
                return { modal, table };
            }
        }
        return null;
    }

    function logLotModalState(symbol) {
        const titles = deepQueryAll('#open-lot-overlay-modal-title');
        const tables = deepQueryAll('#responsiveLotTable');
        log(`Debug for ${symbol}: ${titles.length} title(s), ${tables.length} table(s)`);
        titles.forEach((t, i) => log(`  title[${i}] visible=${isVisible(t)} text="${t.textContent.trim().slice(0, 80)}"`));
        tables.forEach((t, i) => log(`  table[${i}] visible=${isVisible(t)} rows=${t.querySelectorAll('tbody tr.data-row').length}`));
    }

    function extractLotDetailsFromTable(table) {
        const rows = table.querySelectorAll('tbody tr.data-row');
        const lots = [];

        rows.forEach(row => {
            const openDateCell = row.querySelector('th span');
            const qtyCell = row.querySelector('td[name="Qty"]');
            const priceCell = row.querySelector('td[name="Price"]');
            const cpsCell = row.querySelector('td[name="CPS"] span');
            const mktValCell = row.querySelector('td[name="MktVal"] span');
            const costBasisCell = row.querySelector('td[name="CostBasis"] span');
            const gainLossCell = row.querySelector('td[name="GainLoss"] span');
            const gainLossPercentCell = row.querySelector('td[name="GainLossPercent"] span');
            const holdPeriodCell = row.querySelector('td[name="HoldPeriod"] span');

            if (openDateCell && qtyCell && priceCell) {
                lots.push({
                    open_date: parseDate(openDateCell.textContent),
                    quantity: parseValue(qtyCell.textContent),
                    price: parseValue(priceCell.textContent),
                    cost_per_share: parseValue(cpsCell?.textContent),
                    market_value: parseValue(mktValCell?.textContent),
                    cost_basis: parseValue(costBasisCell?.textContent),
                    gain_or_loss: parseValue(gainLossCell?.textContent),
                    gain_or_loss_percentage: parseValue(gainLossPercentCell?.textContent),
                    holding_period: holdPeriodCell?.textContent?.trim() || ''
                });
            }
        });

        return lots;
    }

    function anyLotModalVisible() {
        return deepQueryAll('#open-lot-overlay-modal-title').some(isVisible);
    }

    async function closeLotOverlay(overlay) {
        const closeButton = overlay && (
            deepQuery('.sdps-modal__close', overlay) ||
            deepQuery('button[aria-label*="close" i]', overlay) ||
            (overlay.shadowRoot && deepQuery('button[aria-label*="close" i], .sdps-modal__close', overlay.shadowRoot)));

        if (closeButton) {
            closeButton.click();
        } else {
            log('Close button not found, sending Escape');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }

        const closed = await waitFor(() => !anyLotModalVisible(), 5000);
        if (!closed) {
            log('Modal still visible after close attempt, sending Escape');
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await waitFor(() => !anyLotModalVisible(), 3000);
        }
        await closeMenus();
        await delay(500);
    }

    function storeLots(accountId, symbol, lots) {
        if (!taxLotData[accountId]) taxLotData[accountId] = [];
        let symbolObj = taxLotData[accountId].find(item => item[symbol]);
        if (!symbolObj) {
            symbolObj = { [symbol]: [] };
            taxLotData[accountId].push(symbolObj);
        }
        symbolObj[symbol] = symbolObj[symbol].concat(lots);
    }

    async function processLotDetails(accountId, symbol) {
        /* Prefer a visible modal for this symbol; after a grace period accept a
           matching one even if its layout box reports zero size. */
        let found = await waitFor(() => findLotModalFor(symbol, true), 6000);
        if (!found) found = await waitFor(() => findLotModalFor(symbol, false), 9000);

        if (!found) {
            log(`Lot details for ${symbol} did not load in time`);
            logLotModalState(symbol);
            const anyOpen = deepQueryAll('#open-lot-overlay-modal-title').find(isVisible)?.closest('sdps-modal');
            await closeLotOverlay(anyOpen || deepQuery('#open-lot-overlay'));
            return false;
        }

        const lots = extractLotDetailsFromTable(found.table);
        if (lots.length === 0) {
            log(`No lot rows parsed for ${symbol}`);
            await closeLotOverlay(found.modal);
            return false;
        }

        storeLots(accountId, symbol, lots);
        log(`Extracted ${lots.length} lots for ${symbol} in account ${accountId}`);

        await closeLotOverlay(found.modal);
        return true;
    }

    function findLotDetailsItem(triggerId) {
        const menus = deepQueryAll('sdps-menu[sdpsid="next-steps"]');
        const anchored = menus.filter(m => m.getAttribute('anchor-id') === triggerId);
        /* Fall back to any next-steps menu if the anchor match fails. */
        const candidates = anchored.length ? anchored : menus;
        for (const menu of candidates) {
            const item = deepQueryAll('[role="menuitem"]', menu)
                .find(el => /^lot details$/i.test(el.textContent.trim()));
            if (item && (isVisible(item) || anchored.length)) return item;
        }
        return null;
    }

    /* Re-locate the trigger each time; Angular may re-render rows. */
    function findButton(accountId, symbol) {
        const tbody = document.getElementById(accountId);
        const scope = tbody || document;
        const row = Array.from(scope.querySelectorAll('tr[data-symbol]'))
            .find(r => r.getAttribute('data-symbol') === symbol);
        return row ? row.querySelector('app-next-steps-column sdps-button button') : null;
    }

    async function processPosition({ accountId, symbol }) {
        const key = `${accountId}-${symbol}`;
        if (done.has(key)) return true;

        for (let attempt = 1; attempt <= 3; attempt++) {
            const button = findButton(accountId, symbol);
            if (!button) {
                log(`Button for ${symbol} not found`);
                return false;
            }

            await closeMenus();
            log(`Opening Next Steps menu for: ${symbol} in account ${accountId}` +
                (attempt > 1 ? ` (attempt ${attempt})` : ''));
            button.scrollIntoView({ block: 'center' });
            await delay(400);
            button.click();

            const item = await waitFor(() => findLotDetailsItem(button.id), 4000);
            if (!item) {
                log(`Lot Details option not found for ${symbol}`);
                continue;
            }

            log('Clicking Lot Details option');
            item.click();

            const ok = await processLotDetails(accountId, symbol);
            if (ok) {
                done.add(key);
                return true;
            }
        }
        return false;
    }

    function collectPositions() {
        const buttons = document.querySelectorAll('app-next-steps-column sdps-button button');
        const seen = new Set();
        const positions = [];
        buttons.forEach(button => {
            const row = button.closest('tr[data-symbol]');
            if (!row || !isVisible(button)) return;
            const symbol = row.getAttribute('data-symbol');
            const accountId = button.closest('tbody[id*="holdingsAccount_"]')?.id || 'holdingsAccount_unknown';
            const key = `${accountId}-${symbol}`;
            if (seen.has(key)) return;
            seen.add(key);
            positions.push({ accountId, symbol });
        });
        return positions;
    }

    async function run(positions) {
        for (let i = 0; i < positions.length; i++) {
            log(`Processing ${i + 1} of ${positions.length}: ${positions[i].symbol}`);
            try {
                const ok = await processPosition(positions[i]);
                if (!ok) failed.push(positions[i]);
            } catch (error) {
                log(`Error processing ${positions[i].symbol}: ${error.message}`);
                failed.push(positions[i]);
            }
            await delay(800);
        }

        if (failed.length) {
            const retry = failed;
            failed = [];
            log(`Retrying ${retry.length} failed position(s): ${retry.map(p => p.symbol).join(', ')}`);
            for (const p of retry) {
                try {
                    const ok = await processPosition(p);
                    if (!ok) failed.push(p);
                } catch (error) {
                    log(`Error retrying ${p.symbol}: ${error.message}`);
                    failed.push(p);
                }
                await delay(800);
            }
        }

        displayResults(positions.length);
    }

    function displayResults(expected) {
        log('=== EXTRACTION COMPLETE ===');
        console.log('Tax Lot Data:', JSON.stringify(taxLotData, null, 2));

        const blob = new Blob([JSON.stringify(taxLotData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'schwab-tax-lots.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        const accounts = Object.keys(taxLotData);
        let totalSymbols = 0;
        let totalLots = 0;
        accounts.forEach(accountId => {
            taxLotData[accountId].forEach(symbolObj => {
                Object.keys(symbolObj).forEach(symbol => {
                    totalSymbols++;
                    totalLots += symbolObj[symbol].length;
                });
            });
        });

        const failedMsg = failed.length
            ? `\n\nFAILED (${failed.length}): ${failed.map(p => p.symbol).join(', ')}`
            : '';
        if (failed.length) log(`Failed positions: ${failed.map(p => p.symbol).join(', ')}`);

        alert(`Extraction complete! ${totalSymbols} of ${expected} positions across ${accounts.length} account(s), ${totalLots} total lot entries. Data saved to schwab-tax-lots.json${failedMsg}`);
    }

    function init() {
        log('Starting tax lot extraction...');

        if (!window.location.href.includes('client.schwab.com/app/accounts/positions')) {
            alert('Please navigate to https://client.schwab.com/app/accounts/positions/#/ first');
            return;
        }

        const positions = collectPositions();
        log(`Found ${positions.length} positions`);

        if (positions.length === 0) {
            alert('No Next Steps buttons found. Make sure you are on the positions page.');
            return;
        }

        run(positions);
    }

    init();
})();
