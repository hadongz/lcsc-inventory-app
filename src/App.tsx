import { useEffect, useState } from "react"
import Moment from "moment"
import Papa from "papaparse"
import {
  fetchLcscPart,
  isValidLcscId,
  lcscProductUrl,
  normalizeLcscId,
  priceForQuantity,
  type LcscPart,
} from "./lcsc"

type RowData = {
  lcscId: string
  manufactureId: string
  manufacturer: string
  package: string
  quantity: number
  description: string
  unitPrice: number
}

type BOMData = {
  lcscId: string
  manufactureId: string
  quantity: number
}

type BOMErrorInfo = {
  lcscId: string
  manufactureId: string
  reason: string
  quantity?: number
}

type AggregatedRow = RowData & {
  priceHistory: { quantity: number; unitPrice: number }[]
  totalCost: number
  editedQuantity?: number
}

const STORAGE_KEY = "lcsc-inventory-data"
const FILENAME_KEY = "lcsc-inventory-filename"
// Snapshot taken just before "Apply BOM", so the deduction can be undone.
const BACKUP_KEY = "lcsc-inventory-backup"

const MENU_ITEM = "block w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-gray-700"

export default function InventoryApp() {
  const [data, setData] = useState<AggregatedRow[]>([])
  const [fileName, setFileName] = useState<string>("inventory.csv")
  const [sortField, setSortField] = useState<keyof RowData | null>(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [isLoading, setIsLoading] = useState(true)
  const [bomErrorInfo, setBomErrorInfo] = useState<BOMErrorInfo[]>([])
  const [missingBomComp, setMissingBomComp] = useState<BOMErrorInfo[]>([])
  const [multiplier, setMultiplier] = useState<number>(1)
  const [saveIndicator, setSaveIndicator] = useState<string>("")
  const [hasUnappliedChanges, setHasUnappliedChanges] = useState<boolean>(false)
  const [hasBackup, setHasBackup] = useState<boolean>(false)

  // "Add by LCSC ID" dialog
  const [showMenu, setShowMenu] = useState<boolean>(false)
  const [showAddPart, setShowAddPart] = useState<boolean>(false)
  const [lcscQuery, setLcscQuery] = useState<string>("")
  const [isLookingUp, setIsLookingUp] = useState<boolean>(false)
  const [lookupError, setLookupError] = useState<string>("")
  const [lcscPart, setLcscPart] = useState<LcscPart | null>(null)
  const [addQuantity, setAddQuantity] = useState<string>("1")
  const [addUnitPrice, setAddUnitPrice] = useState<string>("0")
  const [isPriceEdited, setIsPriceEdited] = useState<boolean>(false)

  useEffect(() => {
    loadFromStorage()
  }, [])

  useEffect(() => {
    const allErrors: BOMErrorInfo[] = [
      ...missingBomComp.map((comp) => ({
        ...comp,
        reason: `${comp.lcscId}/${comp.manufactureId} missing ${(comp.quantity || 0) * multiplier} components (not in inventory)`,
      })),
    ]

    data.forEach((row) => {
      if ((row.editedQuantity || 0) > 0) {
        const actualUsage = (row.editedQuantity || 0) * multiplier

        if (actualUsage > row.quantity) {
          const shortage = actualUsage - row.quantity
          const multiplierNote = multiplier !== 1 ? ` (multiplier: ×${multiplier})` : ""
          allErrors.push({
            lcscId: row.lcscId,
            manufactureId: row.manufactureId,
            reason: `${row.lcscId}/${row.manufactureId} lacks ${shortage} components${multiplierNote}`,
          })
        }
      }
    })

    setBomErrorInfo(allErrors)
  }, [multiplier, data, missingBomComp])

  const runFromMenu = (action: () => void) => {
    setShowMenu(false)
    action()
  }

  const loadFromStorage = () => {
    try {
      const savedData = localStorage.getItem(STORAGE_KEY)
      const savedFileName = localStorage.getItem(FILENAME_KEY)

      if (savedData) {
        const parsed = JSON.parse(savedData)
        setData(parsed)
        if (savedFileName) {
          setFileName(savedFileName)
        }
        console.log(`Loaded ${parsed.length} parts from localStorage`)
      }

      // An undo snapshot survives reloads, so the button must come back too.
      setHasBackup(localStorage.getItem(BACKUP_KEY) !== null)
    } catch (error) {
      console.error("Failed to load from localStorage:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const saveToStorage = (newData: AggregatedRow[], newFileName?: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newData))
      if (newFileName) {
        localStorage.setItem(FILENAME_KEY, newFileName)
      }
      console.log(`Saved ${newData.length} parts to localStorage`)
      setSaveIndicator("Saved")
      setTimeout(() => setSaveIndicator(""), 2000)
    } catch (error) {
      console.error("Failed to save to localStorage:", error)
      alert("Failed to save data locally. Changes may be lost.")
    }
  }

  const clearStorage = () => {
    if (window.confirm("Are you sure you want to clear all inventory data?")) {
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(FILENAME_KEY)
      localStorage.removeItem(BACKUP_KEY)
      setData([])
      setFileName("inventory.csv")
      setHasBackup(false)
      alert("All data cleared")
    }
  }

  // Restores the snapshot taken by the last "Apply BOM" and persists it, so
  // undoing survives a reload the same way applying does.
  const undoApply = () => {
    const backup = localStorage.getItem(BACKUP_KEY)
    if (!backup) {
      alert("Nothing to undo — no BOM has been applied.")
      return
    }

    if (!window.confirm("Undo the last Apply BOM? Quantities go back to what they were before it.")) {
      return
    }

    try {
      const restored: AggregatedRow[] = JSON.parse(backup)
      setData(restored)
      saveToStorage(restored)
      localStorage.removeItem(BACKUP_KEY)
      setHasBackup(false)
      setHasUnappliedChanges(false)
      setMissingBomComp([])
      setSaveIndicator("Apply BOM Undone")
      setTimeout(() => setSaveIndicator(""), 2000)
    } catch (error) {
      console.error("Failed to restore backup:", error)
      alert("Could not restore the backup.")
    }
  }

  // Column names vary by exporter — KiCad and EasyEDA write "LCSC Part #" and
  // "Quantity", this app's own export writes "LCSC Part" and "Qty". Match on
  // any of the known spellings, case-insensitively, and tolerate the UTF-8 BOM
  // that lands on the first header of a KiCad/Excel export.
  const pickColumn = (row: Record<string, unknown>, ...names: string[]): string => {
    const normalize = (key: string) => key.replace(/^\uFEFF/, "").trim().toLowerCase()

    for (const name of names) {
      const key = Object.keys(row).find((k) => normalize(k) === name.toLowerCase())
      if (key && row[key] != null && String(row[key]).trim() !== "") {
        return String(row[key]).trim()
      }
    }
    return ""
  }

  const transformRow = (csvRow: any): RowData => {
    return {
      lcscId: pickColumn(csvRow, "LCSC Part Number", "LCSC Part #", "LCSC Part", "LCSC"),
      manufactureId: pickColumn(csvRow, "Manufacture Part Number", "Manufacturer Part Number", "MPN"),
      manufacturer: pickColumn(csvRow, "Manufacturer", "Mfr"),
      package: pickColumn(csvRow, "Package", "Footprint"),
      quantity: parseInt(pickColumn(csvRow, "Quantity", "Qty")) || 0,
      description: pickColumn(csvRow, "Description", "Value"),
      unitPrice: parseFloat(pickColumn(csvRow, "Unit Price($)", "Unit Price")) || 0,
    }
  }

  const transformBOM = (row: any): BOMData => {
    return {
      lcscId: pickColumn(row, "LCSC Part", "LCSC Part #", "LCSC Part Number", "LCSC"),
      // Only used to label warnings, so fall back to whatever names the line.
      manufactureId: pickColumn(
        row,
        "Manfufacture ID",
        "Manufacture ID",
        "Manufacturer Part Number",
        "Manufacture Part Number",
        "Value",
        "Comment",
        "Designator"
      ),
      quantity: parseInt(pickColumn(row, "Qty", "Quantity")) || 0,
    }
  }

  const aggregateByLcscId = (rows: RowData[]): AggregatedRow[] => {
    const grouped = new Map<string, AggregatedRow>()

    rows.forEach((row) => {
      const existing = grouped.get(row.lcscId)

      if (existing) {
        const totalQuantity = existing.quantity + row.quantity
        const totalCost = existing.quantity * existing.unitPrice + row.quantity * row.unitPrice

        existing.quantity = totalQuantity
        existing.unitPrice = totalCost / totalQuantity
        existing.totalCost = totalCost
        existing.priceHistory.push({
          quantity: row.quantity,
          unitPrice: row.unitPrice,
        })
      } else {
        grouped.set(row.lcscId, {
          ...row,
          priceHistory: [{ quantity: row.quantity, unitPrice: row.unitPrice }],
          totalCost: row.quantity * row.unitPrice,
          editedQuantity: 0,
        })
      }
    })

    return Array.from(grouped.values())
  }

  const pickAndLoadCSV = async (combining: boolean = false, isBOMFile: boolean = false) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".csv"
    input.onchange = async (e: any) => {
      const file = e.target.files[0]
      if (!file) return

      const text = await file.text()
      parseCSV(text, combining, isBOMFile, file.name)
    }
    input.click()
  }

  const parseCSV = (
    content: string,
    combining: boolean = false,
    isBOMFile: boolean = false,
    newFileName?: string
  ) => {
    Papa.parse(content, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (isBOMFile) {
          // Without inventory there is nothing to match against, and the rows
          // would otherwise fall through and be parsed as an inventory CSV.
          if (data.length === 0) {
            alert("Import your inventory CSV first.\n\nA BOM is matched against parts already in inventory.")
            return
          }

          const allBOMrows = results.data.map(transformBOM)

          // Lines with no LCSC part number are normal — test points, DNP parts,
          // anything not sourced yet. Skip them instead of reporting each as a
          // missing component, but say how many were skipped.
          const usableRows = allBOMrows.filter((row) => row.lcscId !== "")
          const skippedCount = allBOMrows.length - usableRows.length

          // One part usually spans several designator lines (J4, "J5, J9", J6…
          // are all the same 4P connector). Sum them up front — assigning line
          // by line would let the last line overwrite the earlier ones.
          const totalsByPart = new Map<string, BOMData>()
          usableRows.forEach((row) => {
            const existing = totalsByPart.get(row.lcscId)
            if (existing) {
              existing.quantity += row.quantity
            } else {
              totalsByPart.set(row.lcscId, { ...row })
            }
          })
          const BOMdata = Array.from(totalsByPart.values())
          const totalBomQuantity = BOMdata.reduce((sum, row) => sum + row.quantity, 0)

          if (BOMdata.length === 0) {
            alert(
              `No LCSC part numbers found in this file.\n\nExpected a column named "LCSC Part", "LCSC Part #" or "LCSC Part Number", and a quantity column named "Qty" or "Quantity".`
            )
            return
          }

          const newData = data.map((item) => ({ ...item }))
          const newMissingComponents: BOMErrorInfo[] = []

          for (let i = 0; i < BOMdata.length; i++) {
            const index = newData.findIndex((d) => d.lcscId === BOMdata[i].lcscId)
            if (index === -1) {
              newMissingComponents.push({
                lcscId: BOMdata[i].lcscId,
                manufactureId: BOMdata[i].manufactureId,
                quantity: BOMdata[i].quantity,
                reason: "",
              })
            } else {
              if (combining) {
                newData[index].editedQuantity = (newData[index].editedQuantity || 0) + BOMdata[i].quantity
              } else {
                newData[index].editedQuantity = BOMdata[i].quantity
              }
            }
          }

          setData(newData)

          if (combining) {
            const combinedMissing = [...missingBomComp]

            newMissingComponents.forEach((newComp) => {
              const existingIndex = combinedMissing.findIndex((c) => c.lcscId === newComp.lcscId)
              if (existingIndex >= 0) {
                combinedMissing[existingIndex].quantity =
                  (combinedMissing[existingIndex].quantity || 0) + (newComp.quantity || 0)
              } else {
                combinedMissing.push(newComp)
              }
            })

            setMissingBomComp(combinedMissing)
            setHasUnappliedChanges(true)

            alert(
              `BOM Combined!\n\nAdded ${usableRows.length} lines (${BOMdata.length} unique parts, ${totalBomQuantity} pcs) to existing BOM requirements.${skippedCount > 0 ? `\nSkipped ${skippedCount} lines with no LCSC part number.` : ""}${newMissingComponents.length > 0 ? `\n\nWarning: ${newMissingComponents.length} parts not found in inventory` : ""}`
            )
          } else {
            setMissingBomComp(newMissingComponents)
            setHasUnappliedChanges(true)
            alert(
              `BOM Loaded!\n\nProcessed ${usableRows.length} lines (${BOMdata.length} unique parts, ${totalBomQuantity} pcs).${skippedCount > 0 ? `\nSkipped ${skippedCount} lines with no LCSC part number.` : ""}${newMissingComponents.length > 0 ? `\n\nWarning: ${newMissingComponents.length} parts not found in inventory` : ""}`
            )
          }

          saveToStorage(newData, newFileName)
        } else {
          const rows = results.data.map(transformRow)
          const aggregated = aggregateByLcscId(rows)

          if (combining && data.length > 0) {
            const combined = [...data]
            aggregated.forEach((newRow) => {
              const existingIndex = combined.findIndex((d) => d.lcscId === newRow.lcscId)
              if (existingIndex !== -1) {
                const existing = combined[existingIndex]
                const totalQuantity = existing.quantity + newRow.quantity
                const totalCost = existing.totalCost + newRow.totalCost

                combined[existingIndex] = {
                  ...existing,
                  quantity: totalQuantity,
                  unitPrice: totalCost / totalQuantity,
                  totalCost: totalCost,
                  priceHistory: [...existing.priceHistory, ...newRow.priceHistory],
                }
              } else {
                combined.push(newRow)
              }
            })
            setData(combined)
            setHasBackup(false)
            saveToStorage(combined, newFileName)
            alert(`Combined successfully!\n\nAdded ${aggregated.length} parts.\nNew total: ${combined.length} unique parts.`)
          } else {
            setData(aggregated)
            setHasBackup(false)
            saveToStorage(aggregated, newFileName)
            if (newFileName) setFileName(newFileName)
            alert(`Loaded successfully!\n\nImported ${rows.length} rows.\nAggregated to ${aggregated.length} unique parts.`)
          }
        }
      },
    })
  }

  const exportToCSV = () => {
    if (data.length === 0) {
      alert("No data to export")
      return
    }

    const escapeCSV = (field: string | number): string => {
      const str = String(field)
      // If field contains comma, quote, or newline, wrap in quotes and escape internal quotes
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
      }
      return str
    }

    const headers = [
      "LCSC Part Number",
      "Manufacture Part Number",
      "Manufacturer",
      "Package",
      "Quantity",
      "Description",
      "Unit Price($)",
    ]

    const csvRows = [headers.join(",")]
    const filteredData = data.filter((row) => { return row.quantity > 0 })
    filteredData.forEach((row) => {
      const values = [
        escapeCSV(row.lcscId),
        escapeCSV(row.manufactureId),
        escapeCSV(row.manufacturer),
        escapeCSV(row.package),
        row.quantity,
        escapeCSV(row.description),
        row.unitPrice.toFixed(4),
      ]
      csvRows.push(values.join(","))
    })

    const csvContent = csvRows.join("\n")
    const blob = new Blob([csvContent], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${fileName.replace(".csv", "")}_${Moment().format("HHmmDDMMYYYY")}.csv`
    a.click()
    URL.revokeObjectURL(url)

    alert("Exported successfully!")
  }

  const openAddPart = () => {
    setShowAddPart(true)
    setLcscQuery("")
    setLookupError("")
    setLcscPart(null)
    setAddQuantity("1")
    setAddUnitPrice("0")
    setIsPriceEdited(false)
  }

  const lookupLcscPart = async () => {
    const lcscId = normalizeLcscId(lcscQuery)

    if (!isValidLcscId(lcscId)) {
      setLookupError("Enter an LCSC part number like C14663")
      return
    }

    setIsLookingUp(true)
    setLookupError("")
    setLcscPart(null)

    try {
      const part = await fetchLcscPart(lcscId)
      const quantity = parseInt(addQuantity) || 1

      setLcscPart(part)
      setLcscQuery(part.lcscId)
      setAddUnitPrice(priceForQuantity(part.priceTiers, quantity).toFixed(4))
      setIsPriceEdited(false)
    } catch (error) {
      setLookupError(error instanceof Error ? error.message : "LCSC lookup failed")
    } finally {
      setIsLookingUp(false)
    }
  }

  const handleAddQuantityChange = (value: string) => {
    setAddQuantity(value)

    // Keep the unit price on the matching LCSC price break until it's overridden.
    if (lcscPart && !isPriceEdited) {
      setAddUnitPrice(priceForQuantity(lcscPart.priceTiers, parseInt(value) || 0).toFixed(4))
    }
  }

  const addLcscPartToInventory = () => {
    if (!lcscPart) return

    const quantity = parseInt(addQuantity) || 0
    const unitPrice = parseFloat(addUnitPrice) || 0

    if (quantity <= 0) {
      setLookupError("Quantity must be at least 1")
      return
    }

    const existingIndex = data.findIndex((d) => d.lcscId === lcscPart.lcscId)
    const newData = [...data]

    if (existingIndex === -1) {
      newData.push({
        lcscId: lcscPart.lcscId,
        manufactureId: lcscPart.manufactureId,
        manufacturer: lcscPart.manufacturer,
        package: lcscPart.package,
        description: lcscPart.description,
        quantity,
        unitPrice,
        priceHistory: [{ quantity, unitPrice }],
        totalCost: quantity * unitPrice,
        editedQuantity: 0,
      })
    } else {
      const existing = newData[existingIndex]
      const totalQuantity = existing.quantity + quantity
      const totalCost = existing.totalCost + quantity * unitPrice

      newData[existingIndex] = {
        ...existing,
        manufactureId: existing.manufactureId || lcscPart.manufactureId,
        manufacturer: existing.manufacturer || lcscPart.manufacturer,
        package: existing.package || lcscPart.package,
        description: existing.description || lcscPart.description,
        quantity: totalQuantity,
        unitPrice: totalQuantity > 0 ? totalCost / totalQuantity : unitPrice,
        totalCost,
        priceHistory: [...existing.priceHistory, { quantity, unitPrice }],
      }
    }

    setData(newData)
    setHasBackup(false)
    saveToStorage(newData)
    setShowAddPart(false)

    alert(
      existingIndex === -1
        ? `Added ${lcscPart.lcscId} (${quantity} pcs) to inventory.`
        : `Added ${quantity} pcs to existing ${lcscPart.lcscId}.\nNew quantity: ${newData[existingIndex].quantity}.`
    )
  }

  const clearBOM = () => {
    if (window.confirm("Clear BOM usage data?")) {
      const newData = data.map((row) => ({
        ...row,
        editedQuantity: 0,
      }))
      setData(newData)
      setMissingBomComp([])
      setHasUnappliedChanges(false)
      saveToStorage(newData)
    }
  }

  const applyBOM = () => {
    if (!hasUnappliedChanges) {
      alert("No BOM changes to apply")
      return
    }

    const usedParts = data.filter((row) => (row.editedQuantity || 0) > 0)
    const totalUsed = usedParts.reduce((sum, row) => sum + (row.editedQuantity || 0) * multiplier, 0)

    if (!window.confirm(`Apply BOM usage (×${multiplier})?\n\nThis subtracts ${totalUsed} pcs across ${usedParts.length} parts from your inventory and saves it.\n\nUse "Undo Apply BOM" if you need to reverse it.`)) {
      return
    }

    const newData = data.map((row) => {
      if ((row.editedQuantity || 0) > 0) {
        const usedQty = (row.editedQuantity || 0) * multiplier
        return {
          ...row,
          quantity: Math.max(0, row.quantity - usedQty),
          editedQuantity: 0,
        }
      }
      return row
    })

    // Snapshot the pre-apply state first, so the deduction stays reversible
    // now that it is written straight to localStorage.
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(data))
      setHasBackup(true)
    } catch (error) {
      console.error("Failed to store undo snapshot:", error)
      setHasBackup(false)
    }

    setData(newData)
    setMissingBomComp([])
    setHasUnappliedChanges(false)
    saveToStorage(newData)
    setSaveIndicator("BOM Applied & Saved")
    setTimeout(() => setSaveIndicator(""), 3000)

    alert(`BOM applied and saved.\n\nSubtracted ${totalUsed} pcs across ${usedParts.length} parts.`)
  }

  const deleteRow = (lcscId: string) => {
    const row = data.find((d) => d.lcscId === lcscId)
    if (!row) return

    const label = row.manufactureId ? `${lcscId} (${row.manufactureId})` : lcscId
    if (!window.confirm(`Remove ${label} from inventory?`)) return

    const newData = data.filter((d) => d.lcscId !== lcscId)
    setData(newData)
    saveToStorage(newData)
  }

  const handleQuantityChange = (index: number, value: string) => {
    const newData = [...data]
    const numValue = parseInt(value) || 0
    newData[index].editedQuantity = numValue
    setData(newData)
    setHasUnappliedChanges(true)
    saveToStorage(newData)
  }

  const handleSort = (field: keyof RowData) => {
    if (sortField === field) {
      setSortAsc(!sortAsc)
    } else {
      setSortField(field)
      setSortAsc(true)
    }
  }

  const getSortedData = () => {
    if (!sortField) return data

    return [...data].sort((a, b) => {
      const aVal = a[sortField]
      const bVal = b[sortField]

      if (typeof aVal === "number" && typeof bVal === "number") {
        return sortAsc ? aVal - bVal : bVal - aVal
      }

      const aStr = String(aVal).toLowerCase()
      const bStr = String(bVal).toLowerCase()
      return sortAsc ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr)
    })
  }

  const getFilteredData = () => {
    const sorted = getSortedData()
    if (!searchQuery.trim()) return sorted

    const query = searchQuery.toLowerCase()
    return sorted.filter(
      (row) =>
        row.lcscId.toLowerCase().includes(query) ||
        row.manufactureId.toLowerCase().includes(query) ||
        row.manufacturer.toLowerCase().includes(query) ||
        row.description.toLowerCase().includes(query)
    )
  }

  const filteredData = getFilteredData()

  const totalInventoryValue = data.reduce((sum, row) => sum + row.totalCost, 0)
  const totalUsageCost = data.reduce((sum, row) => {
    const usedQty = (row.editedQuantity || 0) * multiplier
    return sum + usedQty * row.unitPrice
  }, 0)

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <p className="text-gray-400">Loading...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Header */}
      <div className="border-b border-gray-700 p-5 pt-8 bg-gray-800">
        <h1 className="text-2xl font-bold mb-3 text-center text-gray-100">LCSC Inventory Manager</h1>
        <div className="flex flex-wrap gap-2 justify-center">
          <button
            onClick={openAddPart}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          >
            + Add Manually
          </button>
          <button
            onClick={() => pickAndLoadCSV(false, false)}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Import CSV
          </button>
          <button
            onClick={() => pickAndLoadCSV(false, true)}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Import BOM
          </button>

          {/* Everything else lives in the burger menu */}
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              aria-label="More actions"
              aria-expanded={showMenu}
              className={`px-4 py-2 rounded border border-gray-600 text-gray-100 ${showMenu ? "bg-gray-600" : "bg-gray-700 hover:bg-gray-600"
                }`}
            >
              ☰
            </button>

            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-lg border border-gray-600 bg-gray-800 shadow-xl">
                  <p className="px-4 pt-3 pb-1 text-xs font-bold uppercase tracking-wide text-gray-400">
                    Inventory
                  </p>
                  <button onClick={() => runFromMenu(() => pickAndLoadCSV(true, false))} className={MENU_ITEM}>
                    Combine CSV
                  </button>
                  <button onClick={() => runFromMenu(() => exportToCSV())} className={MENU_ITEM}>
                    Export CSV
                  </button>

                  <p className="border-t border-gray-700 px-4 pt-3 pb-1 text-xs font-bold uppercase tracking-wide text-gray-400">
                    BOM
                  </p>
                  <button onClick={() => runFromMenu(() => pickAndLoadCSV(true, true))} className={MENU_ITEM}>
                    Combine BOM
                  </button>
                  <button
                    onClick={() => runFromMenu(applyBOM)}
                    disabled={!hasUnappliedChanges}
                    className={`${MENU_ITEM} font-bold ${hasUnappliedChanges ? "text-yellow-400" : "cursor-not-allowed text-gray-500 hover:bg-transparent"
                      }`}
                  >
                    Apply BOM ✓
                  </button>
                  <button onClick={() => runFromMenu(clearBOM)} className={`${MENU_ITEM} text-orange-400`}>
                    Clear BOM
                  </button>

                  <p className="border-t border-gray-700 px-4 pt-3 pb-1 text-xs font-bold uppercase tracking-wide text-gray-400">
                    Data
                  </p>
                  {hasBackup && (
                    <button onClick={() => runFromMenu(undoApply)} className={MENU_ITEM}>
                      Undo Apply BOM
                    </button>
                  )}
                  <button onClick={() => runFromMenu(clearStorage)} className={`${MENU_ITEM} text-red-400`}>
                    Clear All
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {data.length > 0 && (
        <>
          {/* Search */}
          <div className="p-4 border-b border-gray-700 flex items-center gap-2 bg-gray-800">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by LCSC ID, Mfr ID, Manufacturer, or Description..."
              className="flex-1 h-10 border border-gray-600 rounded-lg px-3 text-sm bg-gray-700 text-gray-100 placeholder-gray-400"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="px-3 py-2 text-gray-400 hover:text-gray-200"
              >
                ✕
              </button>
            )}
          </div>

          {/* Info Panel */}
          <div className="p-4 bg-gray-800 border-b border-gray-700">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-bold text-gray-200">BOM Multiplier:</span>
              <input
                type="number"
                value={multiplier}
                onChange={(e) => setMultiplier(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-20 h-9 border border-green-500 rounded px-2 text-sm text-center font-bold bg-gray-700 text-gray-100"
                min="1"
              />
            </div>

            {bomErrorInfo.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {bomErrorInfo.map((error, i) => (
                  <div key={i} className="w-64 p-3 bg-red-600 text-white rounded text-sm">
                    {error.reason}
                  </div>
                ))}
              </div>
            )}

            <p className="text-sm text-gray-300 mb-1">
              Showing {filteredData.length} of {data.length} parts
            </p>
            <p className="text-sm text-gray-200 mb-1">
              Total Inventory Value: <span className="font-bold">${totalInventoryValue.toFixed(2)}</span>
            </p>
            <p className="text-sm text-gray-200 mb-1">
              BOM Usage Cost (×{multiplier}): <span className="font-bold">${totalUsageCost.toFixed(2)}</span>
            </p>
            <div className="flex items-center gap-2">
              <p className="text-xs text-green-400 italic">
                {`Saved to localStorage: ${fileName}`}{hasBackup ? " · Apply BOM can be undone" : ""}
              </p>
              {saveIndicator && (
                <span className="text-xs text-green-400 font-bold bg-green-900 px-2 py-1 rounded">
                  ✓ {saveIndicator}
                </span>
              )}
              {hasUnappliedChanges && (
                <span className="text-xs text-orange-400 font-bold bg-orange-900 px-2 py-1 rounded">
                  ⚠ Unapplied BOM changes
                </span>
              )}
            </div>
          </div>

          {/* Table */}
          <div className="overflow-auto">
            <div className="inline-block min-w-full">
              {/* Header */}
              <div className="flex border-b border-gray-700 bg-gray-800 sticky top-0">
                <div
                  onClick={() => handleSort("lcscId")}
                  className="w-[100px] p-3 font-bold text-xs text-gray-200 cursor-pointer hover:bg-gray-700 border-r border-gray-700"
                >
                  LCSC ID {sortField === "lcscId" && (sortAsc ? "▲" : "▼")}
                </div>
                <div
                  onClick={() => handleSort("manufacturer")}
                  className="w-[120px] p-3 font-bold text-xs text-gray-200 cursor-pointer hover:bg-gray-700 border-r border-gray-700"
                >
                  Mfr {sortField === "manufacturer" && (sortAsc ? "▲" : "▼")}
                </div>
                <div
                  onClick={() => handleSort("manufactureId")}
                  className="w-[200px] p-3 font-bold text-xs text-gray-200 cursor-pointer hover:bg-gray-700 border-r border-gray-700"
                >
                  Mfr ID {sortField === "manufactureId" && (sortAsc ? "▲" : "▼")}
                </div>
                <div
                  onClick={() => handleSort("package")}
                  className="w-[170px] p-3 font-bold text-xs text-gray-200 cursor-pointer hover:bg-gray-700 border-r border-gray-700"
                >
                  Package {sortField === "package" && (sortAsc ? "▲" : "▼")}
                </div>
                <div
                  onClick={() => handleSort("quantity")}
                  className="w-[80px] p-3 font-bold text-xs text-gray-200 cursor-pointer hover:bg-gray-700 border-r border-gray-700"
                >
                  Qty {sortField === "quantity" && (sortAsc ? "▲" : "▼")}
                </div>
                <div className="w-[100px] p-3 font-bold text-xs text-gray-200 border-r border-gray-700">
                  BOM Qty
                </div>
                <div className="w-[90px] p-3 font-bold text-xs text-gray-200 border-r border-gray-700">
                  Remaining
                </div>
                <div
                  onClick={() => handleSort("unitPrice")}
                  className="w-[100px] p-3 font-bold text-xs text-gray-200 cursor-pointer hover:bg-gray-700 border-r border-gray-700"
                >
                  Unit $ {sortField === "unitPrice" && (sortAsc ? "▲" : "▼")}
                </div>
                <div className="w-[100px] p-3 font-bold text-xs text-gray-200 border-r border-gray-700">
                  Total $
                </div>
                <div
                  onClick={() => handleSort("description")}
                  className="w-[610px] p-3 font-bold text-xs text-gray-200 cursor-pointer hover:bg-gray-700 border-r border-gray-700"
                >
                  Description {sortField === "description" && (sortAsc ? "▲" : "▼")}
                </div>
                <div className="w-[70px] p-3 font-bold text-xs text-gray-200 text-center">
                  Delete
                </div>
              </div>

              {/* Body */}
              <div className="bg-gray-900">
                {filteredData.length > 0 ? (
                  filteredData.map((row, i) => {
                    const actualIndex = data.findIndex((d) => d.lcscId === row.lcscId)
                    const usedQty = (row.editedQuantity || 0) * multiplier
                    const remainingQty = row.quantity - usedQty
                    const remainingCost = remainingQty * row.unitPrice

                    return (
                      <div
                        key={row.lcscId}
                        className={`flex border-b border-gray-700 min-h-[48px] ${i % 2 === 0 ? "bg-gray-800" : "bg-gray-900"}`}
                      >
                        <div className="w-[100px] p-3 text-xs border-r border-gray-700 flex items-center">
                          <a
                            href={lcscProductUrl(row.lcscId)}
                            target="_blank"
                            rel="noreferrer"
                            title={`Open ${row.lcscId} on lcsc.com`}
                            className="text-blue-400 underline hover:text-blue-300"
                          >
                            {row.lcscId}
                          </a>
                        </div>
                        <div className="w-[120px] p-3 text-xs text-gray-300 border-r border-gray-700 flex items-center">
                          {row.manufacturer}
                        </div>
                        <div className="w-[200px] p-3 text-xs text-gray-300 border-r border-gray-700 flex items-center">
                          {row.manufactureId}
                        </div>
                        <div className="w-[170px] p-3 text-xs text-gray-300 border-r border-gray-700 flex items-center">
                          {row.package}
                        </div>
                        <div className="w-[80px] p-3 text-xs text-gray-300 text-right border-r border-gray-700 flex items-center justify-end">
                          {row.quantity}
                        </div>
                        <div className="w-[100px] p-3 border-r border-gray-700 flex items-center">
                          <input
                            type="number"
                            value={row.editedQuantity || ""}
                            onChange={(e) => handleQuantityChange(actualIndex, e.target.value)}
                            placeholder="0"
                            className={`w-full border rounded px-2 py-1 text-xs text-center ${(row.editedQuantity || 0) > 0
                                ? "border-orange-500 bg-orange-900 text-orange-200"
                                : "border-gray-600 bg-gray-700 text-gray-200"
                              }`}
                          />
                        </div>
                        <div
                          className={`w-[90px] p-3 text-xs text-center border-r border-gray-700 flex items-center justify-end ${(row.editedQuantity || 0) > 0 ? "text-orange-400 font-bold" : "text-gray-300"
                            }`}
                        >
                          {remainingQty}
                        </div>
                        <div className="w-[100px] p-3 text-xs text-gray-300 text-right border-r border-gray-700 flex items-center justify-end">
                          ${row.unitPrice.toFixed(4)}
                        </div>
                        <div
                          className={`w-[100px] p-3 text-xs text-right border-r border-gray-700 flex items-center justify-end ${(row.editedQuantity || 0) > 0 ? "text-orange-400 font-bold" : "text-gray-300"
                            }`}
                        >
                          ${remainingCost.toFixed(2)}
                        </div>
                        <div className="w-[610px] p-3 text-xs text-gray-300 border-r border-gray-700 flex items-center line-clamp-2">
                          {row.description}
                        </div>
                        <div className="w-[70px] p-3 flex items-center justify-center">
                          <button
                            onClick={() => deleteRow(row.lcscId)}
                            title={`Remove ${row.lcscId} from inventory`}
                            className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-900 hover:text-red-200"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <div className="p-10 text-center">
                    <p className="text-sm text-gray-400">No parts match your search</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {data.length === 0 && !isLoading && (
        <div className="flex-1 flex flex-col items-center justify-center p-10">
          <p className="text-lg font-bold text-gray-200 mb-2">No inventory data</p>
          <p className="text-sm text-gray-400">Import a CSV file or add a part by LCSC ID to get started</p>
        </div>
      )}

      {showAddPart && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-4 py-10"
          onClick={() => setShowAddPart(false)}
        >
          <div
            className="w-full max-w-2xl rounded-lg border border-gray-700 bg-gray-800 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-100">Add Part by LCSC ID</h2>
              <button
                onClick={() => setShowAddPart(false)}
                className="px-2 text-gray-400 hover:text-gray-200"
              >
                ✕
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={lcscQuery}
                onChange={(e) => setLcscQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && lookupLcscPart()}
                placeholder="e.g. C14663"
                autoFocus
                className="h-10 flex-1 rounded-lg border border-gray-600 bg-gray-700 px-3 text-sm text-gray-100 placeholder-gray-400"
              />
              <button
                onClick={lookupLcscPart}
                disabled={isLookingUp}
                className={`h-10 rounded px-4 text-white ${isLookingUp ? "bg-gray-600 cursor-not-allowed" : "bg-blue-500 hover:bg-blue-600"
                  }`}
              >
                {isLookingUp ? "Fetching..." : "Fetch"}
              </button>
            </div>
            <p className="mt-2 text-xs text-gray-400">
              Details are fetched live from LCSC. Only quantity and unit price are yours to set.
            </p>

            {lookupError && (
              <div className="mt-3 rounded bg-red-600 p-3 text-sm text-white">{lookupError}</div>
            )}

            {lcscPart && (
              <>
                <div className="mt-4 flex gap-4 rounded border border-gray-700 bg-gray-900 p-4">
                  {lcscPart.imageUrl && (
                    <img
                      src={lcscPart.imageUrl}
                      alt={lcscPart.lcscId}
                      className="h-20 w-20 shrink-0 rounded bg-white object-contain"
                    />
                  )}
                  <div className="min-w-0 flex-1 text-xs text-gray-300">
                    <p className="mb-1 text-sm font-bold text-gray-100">
                      {lcscPart.lcscId} — {lcscPart.manufactureId}
                    </p>
                    <p className="mb-1">
                      {lcscPart.manufacturer}
                      {lcscPart.package && ` · ${lcscPart.package}`}
                    </p>
                    <p className="mb-1">{lcscPart.description}</p>
                    <p className="text-gray-400">
                      LCSC stock: {lcscPart.stock.toLocaleString()} · min order: {lcscPart.minBuyNumber}
                      {lcscPart.datasheetUrl && (
                        <>
                          {" · "}
                          <a
                            href={lcscPart.datasheetUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-400 underline hover:text-blue-300"
                          >
                            datasheet
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                </div>

                {lcscPart.priceTiers.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-xs font-bold text-gray-300">LCSC price breaks (USD)</p>
                    <div className="flex flex-wrap gap-2">
                      {lcscPart.priceTiers.map((tier) => (
                        <span
                          key={tier.quantity}
                          className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-200"
                        >
                          {tier.quantity}+ → ${tier.unitPrice.toFixed(4)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-4 flex flex-wrap gap-4">
                  <label className="text-xs text-gray-300">
                    <span className="mb-1 block font-bold">Quantity</span>
                    <input
                      type="number"
                      min="1"
                      value={addQuantity}
                      onChange={(e) => handleAddQuantityChange(e.target.value)}
                      className="h-9 w-32 rounded border border-gray-600 bg-gray-700 px-2 text-sm text-gray-100"
                    />
                  </label>
                  <label className="text-xs text-gray-300">
                    <span className="mb-1 block font-bold">Unit Price ($)</span>
                    <input
                      type="number"
                      min="0"
                      step="0.0001"
                      value={addUnitPrice}
                      onChange={(e) => {
                        setAddUnitPrice(e.target.value)
                        setIsPriceEdited(true)
                      }}
                      className="h-9 w-32 rounded border border-gray-600 bg-gray-700 px-2 text-sm text-gray-100"
                    />
                  </label>
                  <div className="text-xs text-gray-300">
                    <span className="mb-1 block font-bold">Total</span>
                    <p className="flex h-9 items-center font-bold text-gray-100">
                      ${((parseInt(addQuantity) || 0) * (parseFloat(addUnitPrice) || 0)).toFixed(2)}
                    </p>
                  </div>
                </div>

                {data.some((row) => row.lcscId === lcscPart.lcscId) && (
                  <p className="mt-3 text-xs text-orange-400">
                    Already in inventory — this quantity will be added and the unit price averaged.
                  </p>
                )}

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    onClick={() => setShowAddPart(false)}
                    className="rounded bg-gray-700 px-4 py-2 text-gray-200 hover:bg-gray-600"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={addLcscPartToInventory}
                    className="rounded bg-green-600 px-4 py-2 font-bold text-white hover:bg-green-700"
                  >
                    Add to Inventory
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}