import { z } from 'zod';

import { fail, handleError, ok, searchParamsToObject } from '@/lib/api';
import { getToken, listTrades } from '@/lib/db/repositories';
import * as birdeye from '@/lib/providers/birdeye';
import { isValidSolanaAddress } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const querySchema = z.object({
  interval: z.enum(['1m', '5m', '15m', '1H', '4H', '1D']).default('15m'),
  hours: z.coerce.number().min(1).max(24 * 30).default(24),
});

/**
 * GET /api/tokens/[mint]/chart
 *
 * Birdeye OHLCV candles plus the whale trades that landed inside the same
 * window, so the chart can plot buy/sell markers against price.
 */
export async function GET(request: Request, { params }: { params: { mint: string } }) {
  try {
    const mint = params.mint;
    if (!isValidSolanaAddress(mint)) return fail('Invalid mint address', 400);

    const parsed = querySchema.safeParse(searchParamsToObject(request.url));
    if (!parsed.success) {
      return fail('Invalid query parameters', 400, { issues: parsed.error.flatten().fieldErrors });
    }

    const since = new Date(Date.now() - parsed.data.hours * 3600_000).toISOString();

    const [token, candles, trades] = await Promise.all([
      getToken(mint),
      birdeye.getOhlcv(mint, parsed.data.interval, parsed.data.hours),
      listTrades({ mint, since, pageSize: 200 }),
    ]);

    return ok({
      token,
      interval: parsed.data.interval,
      candles: candles.map((candle) => ({
        time: candle.unixTime * 1000,
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
        volume: candle.v,
      })),
      markers: trades.rows.map((trade) => ({
        time: new Date(trade.block_time).getTime(),
        side: trade.side,
        usdValue: trade.usd_value,
        price: trade.price_usd,
        whale: trade.whale_address,
        signature: trade.signature,
      })),
      /** Empty candles almost always mean a missing or rate-limited API key. */
      note: candles.length ? undefined : 'No candles returned — check BIRDEYE_API_KEY and plan limits.',
    });
  } catch (error) {
    return handleError(error, 'tokens.chart');
  }
}
