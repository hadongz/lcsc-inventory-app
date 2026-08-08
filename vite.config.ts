import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Served from the site root by default (Cloudflare Pages). The droplet serves
// it from a subpath instead: BASE_PATH=/components-inventory/ npm run build
const rawBase = process.env.BASE_PATH || '/'
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`

const lcscPath = `${base}api/lcsc-detail`

const LCSC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// In production this path is served by `functions/api/lcsc-detail.ts`
// (Cloudflare Pages) or by nginx (droplet); locally we forward it straight to
// LCSC, which has no CORS headers.
//
// LCSC sits behind Akamai, which denies the browser's forwarded header set
// (and any request with no User-Agent), so send the same minimal headers the
// other two do rather than passing the originals through.
const lcscProxy: Record<string, ProxyOptions> = {
  [lcscPath]: {
    target: 'https://wmsc.lcsc.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(lcscPath, '/ftps/wm/product/detail'),
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        for (const header of proxyReq.getHeaderNames()) {
          if (header !== 'host') proxyReq.removeHeader(header)
        }
        proxyReq.setHeader('accept', 'application/json')
        proxyReq.setHeader('user-agent', LCSC_USER_AGENT)
      })
    },
  },
}

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  server: { proxy: lcscProxy },
  preview: { proxy: lcscProxy },
})
