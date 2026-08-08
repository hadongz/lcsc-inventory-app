// Cloudflare Pages Function.
//
// LCSC's public product API serves everything we need but sends no CORS
// headers, so the browser cannot call it directly. This proxies it and hands
// the response back untouched — `src/lcsc.ts` does the field mapping.
//
// `vite.config.ts` proxies the same path to the same upstream during `npm run dev`.

const LCSC_DETAIL_URL = "https://wmsc.lcsc.com/ftps/wm/product/detail"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=3600" : "no-store",
    },
  })

export const onRequestGet = async ({ request }: { request: Request }) => {
  const productCode = (new URL(request.url).searchParams.get("productCode") || "").trim().toUpperCase()

  if (!/^C\d+$/.test(productCode)) {
    return json({ error: "Expected an LCSC part number like C14663" }, 400)
  }

  let upstream: Response
  try {
    upstream = await fetch(`${LCSC_DETAIL_URL}?productCode=${productCode}`, {
      // LCSC answers 403 to any request without a User-Agent, and the Workers
      // runtime sends none unless we set one explicitly.
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    })
  } catch {
    return json({ error: "Could not reach LCSC" }, 502)
  }

  if (!upstream.ok) {
    return json({ error: `LCSC responded with HTTP ${upstream.status}` }, 502)
  }

  return json(await upstream.json())
}
