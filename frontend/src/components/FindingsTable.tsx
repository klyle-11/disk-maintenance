import { useState } from "react";
import {
  formatBytes,
  getCategoryDisplayName,
  getRiskColor,
  getRiskLabel,
} from "../api";
import type { Finding } from "../api";
import "./FindingsTable.css";

type SortField = "score" | "category" | "riskLevel" | "estimatedReclaimableBytes";
type SortDirection = "asc" | "desc";

interface FindingsTableProps {
  findings: Finding[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
}

export function FindingsTable({
  findings,
  selectedIds,
  onSelectionChange,
}: FindingsTableProps) {
  const [sortField, setSortField] = useState<SortField>("score");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const sortedFindings = [...findings].sort((a, b) => {
    let comparison = 0;

    switch (sortField) {
      case "score":
        comparison = a.score - b.score;
        break;
      case "category":
        comparison = a.category.localeCompare(b.category);
        break;
      case "riskLevel":
        const riskOrder = { low: 0, medium: 1, high: 2 };
        comparison = riskOrder[a.riskLevel] - riskOrder[b.riskLevel];
        break;
      case "estimatedReclaimableBytes":
        comparison = a.estimatedReclaimableBytes - b.estimatedReclaimableBytes;
        break;
    }

    return sortDirection === "asc" ? comparison : -comparison;
  });

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      onSelectionChange(new Set(findings.map((f) => f.id)));
    } else {
      onSelectionChange(new Set());
    }
  };

  const handleSelect = (id: string, checked: boolean) => {
    const newIds = new Set(selectedIds);
    if (checked) {
      newIds.add(id);
    } else {
      newIds.delete(id);
    }
    onSelectionChange(newIds);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="sort-icon">-</span>;
    return <span className="sort-icon">{sortDirection === "asc" ? "^" : "v"}</span>;
  };

  if (findings.length === 0) {
    return (
      <div className="findings-empty">
        <p>No findings to display.</p>
        <p>Run a scan to analyze your disk.</p>
      </div>
    );
  }

  return (
    <div className="findings-table-container">
      <table className="findings-table">
        <thead>
          <tr>
            <th className="col-checkbox">
              <input
                type="checkbox"
                checked={selectedIds.size === findings.length && findings.length > 0}
                onChange={(e) => handleSelectAll(e.target.checked)}
              />
            </th>
            <th
              className="col-category sortable"
              onClick={() => handleSort("category")}
            >
              Category <SortIcon field="category" />
            </th>
            <th
              className="col-risk sortable"
              onClick={() => handleSort("riskLevel")}
            >
              Risk <SortIcon field="riskLevel" />
            </th>
            <th
              className="col-size sortable"
              onClick={() => handleSort("estimatedReclaimableBytes")}
            >
              Reclaimable <SortIcon field="estimatedReclaimableBytes" />
            </th>
            <th className="col-path">Path</th>
            <th className="col-reason">Reason</th>
            <th
              className="col-score sortable"
              onClick={() => handleSort("score")}
            >
              Score <SortIcon field="score" />
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedFindings.map((finding) => (
            <>
              <tr
                key={finding.id}
                className={`finding-row ${selectedIds.has(finding.id) ? "selected" : ""}`}
                onClick={() => setExpandedId(expandedId === finding.id ? null : finding.id)}
              >
                <td className="col-checkbox" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(finding.id)}
                    onChange={(e) => handleSelect(finding.id, e.target.checked)}
                  />
                </td>
                <td className="col-category">
                  <span className="category-badge">
                    {getCategoryDisplayName(finding.category)}
                  </span>
                </td>
                <td className="col-risk">
                  <span
                    className="risk-badge"
                    style={{ backgroundColor: getRiskColor(finding.riskLevel) }}
                  >
                    {getRiskLabel(finding.riskLevel)}
                  </span>
                </td>
                <td className="col-size">
                  {formatBytes(finding.estimatedReclaimableBytes)}
                </td>
                <td className="col-path" title={finding.paths[0]}>
                  {finding.paths[0]}
                  {finding.paths.length > 1 && (
                    <span className="more-paths">+{finding.paths.length - 1} more</span>
                  )}
                </td>
                <td className="col-reason" title={finding.reason}>
                  {finding.reason}
                </td>
                <td className="col-score">{finding.score.toFixed(0)}</td>
              </tr>
              {expandedId === finding.id && finding.paths.length > 1 && (
                <tr key={`${finding.id}-expanded`} className="expanded-row">
                  <td colSpan={7}>
                    <div className="expanded-paths">
                      <strong>All paths ({finding.paths.length}):</strong>
                      <ul>
                        {finding.paths.map((path, i) => (
                          <li key={i}>{path}</li>
                        ))}
                      </ul>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
