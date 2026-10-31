# Market Square

A small authoritative multiplayer 3D economy game for up to 12 players per town. Players open logging companies, farms, furniture factories, and retail stores; produce and trade physical goods; hire workers; issue and trade shares; and distribute dividends.

The expanded low-poly city includes 80 business plots, a broad road grid, an industrial district, moving delivery traffic, and an instanced skyline tuned for smooth browser rendering.

## Run locally

Requirements: Node.js 22.5+ (the project uses the built-in SQLite module).

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Create a town, then open the same URL in another browser or private window and join using its five-letter room code. All runtime assets, including Three.js, are served locally.

Progress is saved to `data/market-square.db`. Production is driven only while the server is running and resumes from its saved state without offline catch-up.
Rooms run in monthly seasons. On the first UTC day of each month, money, companies, inventories, orders, and shares reset while player identities and the room code remain available for the new season. Graceful shutdowns flush all active rooms before exit, and WAL-mode SQLite plus periodic snapshots protect live progress.

## Controls

- **WASD:** move quickly through the expanded city
- **Drag mouse:** orbit the camera
- **Mouse wheel:** smoothly zoom in and out
- **Click a building:** open its company panel
- **Bottom dock:** open business, goods market, stock exchange, and player panels

## Economy notes

- New players start with $1,000. Businesses cost $70–$120 and include $50 in company working cash.
- The main loop is intentionally direct: produce goods, sell real inventory to the town wholesaler, then collect company cash personally.
- Factories begin with enough wood for three batches and stores begin with food and furniture, so every starter choice can earn immediately.
- Player cash and company cash remain separate for accounting; advanced funding controls are collapsed by default.
- Sell orders escrow real inventory; buy orders escrow real company/player cash.
- Open orders can be cancelled, returning all remaining escrow.
- Production takes 6–10 seconds; factory batches consume 2 wood and make 2 furniture.
- Retail stores can sell food and furniture to budget-limited, price-sensitive NPC customers.
- Owners choose and can rename their companies; advanced share tools stay collapsed during normal operations.
- Stock prices are only created by completed buy/sell order matches.
- New share issues are capped at 2,000 total shares per company and dilute existing ownership.
- Dividends cannot exceed company cash and are paid proportionally to current shareholders.

## Verification

```bash
npm test
```

The integration test boots an isolated server and uses two real WebSocket clients to verify an escrowed goods trade, an issued-share stock trade, ownership, company cash, and trade pricing.
