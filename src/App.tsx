import { useEffect, useState } from "react"
import Moment from "moment"
import Papa from "papaparse"

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
  const [isModifiedFromStorage, setIsModifiedFromStorage] = useState<boolean>(false)

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
      setData([])
      setFileName("inventory.csv")
      setIsModifiedFromStorage(false)
      alert("All data cleared")
    }
  }

  const reloadOriginal = () => {
    if (window.confirm("Reload original inventory from localStorage? Any applied changes will be lost.")) {
      loadFromStorage()
      setIsModifiedFromStorage(false)
      setHasUnappliedChanges(false)
      setMissingBomComp([])
      setSaveIndicator("Original Reloaded")
      setTimeout(() => setSaveIndicator(""), 2000)
    }
  }

  const transformRow = (csvRow: any): RowData => {
    return {
      lcscId: csvRow["LCSC Part Number"]?.trim() || "",
      manufactureId: csvRow["Manufacture Part Number"]?.trim() || "",
      manufacturer: csvRow["Manufacturer"]?.trim() || "",
      package: csvRow["Package"]?.trim() || "",
      quantity: parseInt(csvRow["Quantity"]) || 0,
      description: csvRow["Description"]?.trim() || "",
      unitPrice: parseFloat(csvRow["Unit Price($)"]) || 0,
    }
  }

  const transformBOM = (row: any): BOMData => {
    return {
      lcscId: row["LCSC Part"]?.trim() || "",
      manufactureId: row["Manfufacture ID"]?.trim() || "",
      quantity: parseInt(row["Qty"]) || 0,
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
        if (isBOMFile && data.length > 0) {
          const BOMdata = results.data.map(transformBOM)
          const newData = data.map((item) => ({ ...item }))
          const newMissingComponents: BOMErrorInfo[] = []

          for (let i = 0; i < BOMdata.length; i++) {
            let index = newData.findIndex((d) => d.lcscId === BOMdata[i].lcscId)
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
              `BOM Combined!\n\nAdded ${BOMdata.length} parts to existing BOM requirements.\n${newMissingComponents.length > 0 ? `\nWarning: ${newMissingComponents.length} parts not found in inventory` : ""}`
            )
          } else {
            setMissingBomComp(newMissingComponents)
            setHasUnappliedChanges(true)
            alert(
              `BOM Loaded!\n\nProcessed ${BOMdata.length} parts from BOM.\n${newMissingComponents.length > 0 ? `\nWarning: ${newMissingComponents.length} parts not found in inventory` : ""}`
            )
          }

          // Only save if we haven't applied changes (modified from storage)
          if (!isModifiedFromStorage) {
            saveToStorage(newData, newFileName)
          }
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
            setIsModifiedFromStorage(false)
            saveToStorage(combined, newFileName)
            alert(`Combined successfully!\n\nAdded ${aggregated.length} parts.\nNew total: ${combined.length} unique parts.`)
          } else {
            setData(aggregated)
            setIsModifiedFromStorage(false)
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

    if (isModifiedFromStorage) {
      alert("Exported successfully!\n\nNote: Exported data includes applied BOM changes.\nOriginal inventory remains in localStorage.")
    } else {
      alert("Exported successfully!")
    }
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

      if (!isModifiedFromStorage) {
        saveToStorage(newData)
      }
    }
  }

  const applyBOM = () => {
    if (!hasUnappliedChanges) {
      alert("No BOM changes to apply")
      return
    }

    if (!window.confirm(`Apply BOM usage (×${multiplier})? This will subtract used quantities from the working copy.\n\nOriginal inventory remains safe in localStorage - reload page to restore.`)) {
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

    setData(newData)
    setMissingBomComp([])
    setHasUnappliedChanges(false)
    setIsModifiedFromStorage(true)
    setSaveIndicator("BOM Applied (Not Saved)")
    setTimeout(() => setSaveIndicator(""), 3000)

    alert("BOM usage applied! Quantities updated in working copy.\n\nOriginal inventory is safe in localStorage.\nReload page to restore original.")
  }

  const handleQuantityChange = (index: number, value: string) => {
    const newData = [...data]
    const numValue = parseInt(value) || 0
    newData[index].editedQuantity = numValue
    setData(newData)
    setHasUnappliedChanges(true)

    if (!isModifiedFromStorage) {
      saveToStorage(newData)
    }
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
            onClick={() => pickAndLoadCSV(false, false)}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Import CSV
          </button>
          <button
            onClick={() => pickAndLoadCSV(true, false)}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Combine CSV
          </button>
          <button
            onClick={() => pickAndLoadCSV(false, true)}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Load BOM
          </button>
          <button
            onClick={() => pickAndLoadCSV(true, true)}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Combine BOM
          </button>
          <button
            onClick={exportToCSV}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Export CSV
          </button>
          <button
            onClick={applyBOM}
            className={`px-4 py-2 rounded font-bold ${hasUnappliedChanges
                ? "bg-yellow-500 text-white hover:bg-yellow-600"
                : "bg-gray-700 text-gray-500 cursor-not-allowed"
              }`}
            disabled={!hasUnappliedChanges}
          >
            Apply BOM ✓
          </button>
          {isModifiedFromStorage && (
            <button
              onClick={reloadOriginal}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Reload Original
            </button>
          )}
          <button
            onClick={clearBOM}
            className="px-4 py-2 bg-orange-500 text-white rounded hover:bg-orange-600"
          >
            Clear BOM
          </button>
          <button
            onClick={clearStorage}
            className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
          >
            Clear All
          </button>
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
                {isModifiedFromStorage ? "Viewing: Applied Changes (Original in localStorage)" : `Saved to localStorage: ${fileName}`}
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
                  className="w-[610px] p-3 font-bold text-xs text-gray-200 cursor-pointer hover:bg-gray-700"
                >
                  Description {sortField === "description" && (sortAsc ? "▲" : "▼")}
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
                        <div className="w-[100px] p-3 text-xs text-gray-300 border-r border-gray-700 flex items-center">
                          {row.lcscId}
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
                        <div className="w-[610px] p-3 text-xs text-gray-300 flex items-center line-clamp-2">
                          {row.description}
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
          <p className="text-sm text-gray-400">Import a CSV file to get started</p>
        </div>
      )}
    </div>
  )
}