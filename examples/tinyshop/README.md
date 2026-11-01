# tinyshop

A small invented shop, here to show what a stemap map looks like. It is not a real store and it does not run.

From the root of this repository:

```bash
bun run demo          # compile the page and open it
bun run demo status   # list the claims the code no longer backs
```

The map in `.stemap/` was locked while refunds had a 30 day window. The code now says 14, so the page flags each claim that rests on `refundOrder`. One of them is wrong, and nothing but the code changed.
