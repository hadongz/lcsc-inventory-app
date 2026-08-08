export type LcscPriceTier = {
  quantity: number
  unitPrice: number
}

export type LcscPart = {
  lcscId: string
  manufactureId: string
  manufacturer: string
  package: string
  description: string
  stock: number
  minBuyNumber: number
  datasheetUrl: string
  imageUrl: string
  priceTiers: LcscPriceTier[]
}

type LcscDetailResult = {
  productCode?: string
  productModel?: string
  brandNameEn?: string
  encapStandard?: string
  productIntroEn?: string
  productDescEn?: string
  productNameEn?: string
  stockNumber?: number
  minBuyNumber?: number
  pdfUrl?: string
  productImages?: string[]
  productPriceList?: { ladder?: number; usdPrice?: number; productPrice?: string }[]
}

// Accepts "C14663", "c14663" or a bare "14663" and returns the canonical form.
export const normalizeLcscId = (raw: string): string => {
  const trimmed = raw.trim().toUpperCase()
  return /^\d+$/.test(trimmed) ? `C${trimmed}` : trimmed
}

export const isValidLcscId = (id: string): boolean => /^C\d+$/.test(id)

// LCSC redirects the bare part-number form to the full product page.
export const lcscProductUrl = (lcscId: string): string =>
  `https://www.lcsc.com/product-detail/${encodeURIComponent(lcscId)}.html`

const toPriceTiers = (result: LcscDetailResult): LcscPriceTier[] =>
  (result.productPriceList || [])
    .map((tier) => ({
      quantity: tier.ladder || 1,
      unitPrice: tier.usdPrice ?? parseFloat(tier.productPrice || "0") ?? 0,
    }))
    .filter((tier) => tier.unitPrice > 0)
    .sort((a, b) => a.quantity - b.quantity)

// LCSC ladders are "this price from N units up", so the applicable tier is the
// highest one the quantity reaches. Below the first ladder we still quote it.
export const priceForQuantity = (tiers: LcscPriceTier[], quantity: number): number => {
  if (tiers.length === 0) return 0

  const reached = tiers.filter((tier) => quantity >= tier.quantity)
  return reached.length > 0 ? reached[reached.length - 1].unitPrice : tiers[0].unitPrice
}

// Relative to the deployment's base path, so the whole app — page and API —
// lives under one prefix. BASE_URL is "/" on Cloudflare Pages and
// "/components-inventory/" on the droplet; Vite always gives it a trailing slash.
const DETAIL_ENDPOINT = `${import.meta.env.BASE_URL}api/lcsc-detail`

export const fetchLcscPart = async (lcscId: string): Promise<LcscPart> => {
  const response = await fetch(`${DETAIL_ENDPOINT}?productCode=${encodeURIComponent(lcscId)}`)
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(payload?.error || `LCSC lookup failed (HTTP ${response.status})`)
  }

  const result: LcscDetailResult | null = payload?.result
  if (!result?.productCode) {
    throw new Error(`No LCSC part found for ${lcscId}`)
  }

  return {
    lcscId: result.productCode,
    manufactureId: result.productModel?.trim() || "",
    manufacturer: result.brandNameEn?.trim() || "",
    package: result.encapStandard?.trim() || "",
    description:
      result.productIntroEn?.trim() ||
      result.productDescEn?.trim() ||
      result.productNameEn?.trim() ||
      "",
    stock: result.stockNumber || 0,
    minBuyNumber: result.minBuyNumber || 1,
    datasheetUrl: result.pdfUrl || "",
    imageUrl: result.productImages?.[0] || "",
    priceTiers: toPriceTiers(result),
  }
}
