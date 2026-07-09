#!/usr/bin/env python3
"""
yfinance bridge for agent-trading-desk.

Fetches fundamentals (PER/PBR/PSR/PCR, margins, growth) + OHLCV history and
computes technical indicators (SMA/EMA/RSI/MACD/Bollinger/ATR, returns,
support/resistance). Emits one JSON object to stdout.

Usage:
  python3 yfinance_fetch.py --tickers 005930.KS,AAPL [--period 1y] [--interval 1d]
  echo '{"tickers":["AAPL"],"period":"1y"}' | python3 yfinance_fetch.py --stdin

This is the ONLY place that touches the Yahoo API. The CLI caches the result as
the single source of truth; all agents read that cache.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

import numpy as np
import pandas as pd

try:
    import yfinance as yf
    YF_VERSION = getattr(yf, "__version__", "unknown")
except Exception as exc:  # pragma: no cover
    print(json.dumps({"error": f"yfinance import failed: {exc}"}))
    sys.exit(1)


FUNDAMENTAL_KEYS = [
    "symbol", "currency", "currentPrice", "marketCap", "fiftyTwoWeekHigh",
    "fiftyTwoWeekLow", "beta",
    # valuation
    "trailingPE", "forwardPE", "pegRatio", "priceToBook",
    "priceToSalesTrailing12Months", "enterpriseToRevenue", "enterpriseToEbitda",
    "dividendYield", "payoutRatio",
    # profitability
    "profitMargins", "operatingMargins", "grossMargins", "returnOnEquity",
    "returnOnAssets",
    # growth
    "revenueGrowth", "earningsGrowth", "earningsQuarterlyGrowth",
    "revenueQuarterlyGrowth",
    # size/balance sheet
    "totalRevenue", "totalCash", "totalCashPerShare", "totalDebt",
    "freeCashflow", "operatingCashflow", "bookValue",
    "debtToEquity", "currentRatio", "quickRatio",
]


def _to_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if isinstance(f, float) and (np.isnan(f) or np.isinf(f)):
        return None
    return f


def _as_series(x: Any) -> pd.Series:
    s = pd.Series(x)
    if isinstance(s, pd.DataFrame):
        s = s.iloc[:, 0]
    return pd.Series(s.squeeze())


def sma(series: Any, n: int) -> float | None:
    s = _as_series(series)
    if len(s) < n:
        return None
    return _to_float(s.tail(n).mean())


def ema(series: Any, n: int) -> float | None:
    s = _as_series(series)
    if len(s) < n:
        return None
    return _to_float(s.ewm(span=n, adjust=False).mean().iloc[-1])


def rsi(series: Any, n: int = 14) -> float | None:
    s = _as_series(series)
    delta = s.diff()
    if len(delta) < n + 1:
        return None
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / n, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / n, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out = 100 - (100 / (1 + rs))
    return _to_float(_as_series(out).iloc[-1])


def macd(series: Any):
    s = _as_series(series)
    if len(s) < 35:
        return None, None, None
    ema12 = s.ewm(span=12, adjust=False).mean()
    ema26 = s.ewm(span=26, adjust=False).mean()
    line = ema12 - ema26
    signal = line.ewm(span=9, adjust=False).mean()
    hist = line - signal
    return _to_float(line.iloc[-1]), _to_float(signal.iloc[-1]), _to_float(hist.iloc[-1])


def bollinger(series: Any, n: int = 20, k: float = 2.0):
    s = _as_series(series)
    if len(s) < n:
        return None, None, None
    window = s.tail(n)
    mid = _to_float(window.mean())
    sd = _to_float(window.std(ddof=0))
    if mid is None or sd is None:
        return None, mid, None
    return mid + k * sd, mid, mid - k * sd


def atr(high: Any, low: Any, close: Any, n: int = 14) -> float | None:
    c = _as_series(close)
    h = _as_series(high)
    l = _as_series(low)
    if len(c) < n + 1:
        return None
    prev_close = c.shift(1)
    tr = pd.concat(
        [(h - l), (h - prev_close).abs(), (l - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    return _to_float(tr.tail(n).mean())


def support_resistance(high: Any, low: Any, n: int = 60):
    window_h = _as_series(high).tail(n)
    window_l = _as_series(low).tail(n)
    if len(window_h) == 0:
        return None, None
    return _to_float(window_l.min()), _to_float(window_h.max())


def pct_return(series: Any, days: int) -> float | None:
    s = _as_series(series)
    if len(s) <= days:
        return None
    last = s.iloc[-1]
    prev = s.iloc[-1 - days]
    if prev in (0, None) or np.isnan(prev):
        return None
    return _to_float((last - prev) / prev)


def fetch_ticker(ticker: str, period: str, interval: str) -> dict[str, Any]:
    out: dict[str, Any] = {"ticker": ticker}
    try:
        tk = yf.Ticker(ticker)
        info = {}
        try:
            info = tk.info or {}
        except Exception:
            info = {}
        fund: dict[str, Any] = {k: _to_float(info.get(k)) for k in FUNDAMENTAL_KEYS}
        # PCR (price-to-cash-flow) approx: marketCap / operatingCashflow
        mcap = fund.get("marketCap")
        ocf = fund.get("operatingCashflow")
        fcf = fund.get("freeCashflow")
        if mcap and ocf and ocf != 0:
            fund["priceToCashflow"] = _to_float(mcap / abs(ocf))
        elif mcap and fcf and fcf != 0:
            fund["priceToCashflow"] = _to_float(mcap / abs(fcf))
        out["fundamentals"] = fund
        out["name"] = info.get("longName") or info.get("shortName")
        out["fundamentals"]["name"] = out["name"]

        # history for TA
        hist = tk.history(period=period, interval=interval, auto_adjust=False)
        if hist is None or hist.empty:
            out["technicals"] = {"recent": []}
            return out
        hist = hist.dropna(subset=["Close"])
        if hist.empty:
            out["technicals"] = {"recent": []}
            return out
        close = hist["Close"]
        high = hist["High"]
        low = hist["Low"]
        vol = hist["Volume"]
        tech = {
            "sma20": sma(close, 20),
            "sma50": sma(close, 50),
            "sma200": sma(close, 200),
            "ema12": ema(close, 12),
            "ema26": ema(close, 26),
            "rsi14": rsi(close, 14),
            "bbUpper": None,
            "bbMiddle": None,
            "bbLower": None,
            "atr14": atr(high, low, close, 14),
            "return1d": pct_return(close, 1),
            "return5d": pct_return(close, 5),
            "return20d": pct_return(close, 20),
            "return60d": pct_return(close, 60),
        }
        up, mid, lo = bollinger(close, 20, 2.0)
        tech["bbUpper"], tech["bbMiddle"], tech["bbLower"] = up, mid, lo
        m_line, m_sig, m_hist = macd(close)
        tech["macd"], tech["macdSignal"], tech["macdHist"] = m_line, m_sig, m_hist
        sup, res = support_resistance(high, low, 60)
        tech["support"], tech["resistance"] = sup, res
        # recent candles (last 30)
        recent_df = hist.tail(30).reset_index()
        recent = []
        for _, r in recent_df.iterrows():
            d = r.get("Date") or r.get("Datetime")
            recent.append({
                "date": str(d),
                "open": _to_float(r["Open"]),
                "high": _to_float(r["High"]),
                "low": _to_float(r["Low"]),
                "close": _to_float(r["Close"]),
                "volume": _to_float(r["Volume"]),
            })
        tech["recent"] = recent
        out["technicals"] = tech
        out["fundamentals"]["price"] = _to_float(_as_series(close).iloc[-1])
        return out
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", default="")
    ap.add_argument("--period", default="1y")
    ap.add_argument("--interval", default="1d")
    ap.add_argument("--stdin", action="store_true")
    args = ap.parse_args()

    if args.stdin:
        payload = json.load(sys.stdin)
        tickers = payload.get("tickers", [])
        period = payload.get("period", args.period)
        interval = payload.get("interval", args.interval)
    else:
        tickers = [t.strip() for t in args.tickers.split(",") if t.strip()]
        period = args.period
        interval = args.interval

    result = {
        "yfinanceVersion": YF_VERSION,
        "tickers": [fetch_ticker(t, period, interval) for t in tickers],
    }
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
