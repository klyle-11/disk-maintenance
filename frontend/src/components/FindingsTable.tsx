import { useState } from "react";
import {
  formatBytes,
  getCategoryDisplayName,
} from "../api";
import type { Finding } from "../api";
import "./FindingsTable.css";

type SortField = "category" | "totalBytes";
type SortDirection = "asc" | "desc";

interface FindingsTableProps {
  findings: Finding[];
}

export function FindingsTable({ findings }: FindingsTableProps) {
  const [sortField, setSortField] = useState<SortField>("totalBytes");
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
      case "category":
        comparison = a.category.localeCompare(b.category);
        break;
      case "totalBytes":
        comparison = a.totalBytes - b.totalBytes;
        break;
    }

    return sortDirection === "asc" ? comparison : -comparison;
  });

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
            <th
              className="col-category sortable"
              onClick={() => handleSort("category")}
            >
              Category <SortIcon field="category" />
            </th>
            <th
              className="col-size sortable"
              onClick={() => handleSort("totalBytes")}
            >
              Size <SortIcon field="totalBytes" />
            </th>
            <th className="col-path">Path</th>
            <th className="col-reason">Reason</th>
          </tr>
        </thead>
        <tbody>
          {sortedFindings.map((finding) => (
            <>
              <tr
                key={finding.id}
                className="finding-row"
                onClick={() => setExpandedId(expandedId === finding.id ? null : finding.id)}
              >
                <td className="col-category">
                  <span className="category-badge">
                    {getCategoryDisplayName(finding.category)}
                  </span>
                </td>
                <td className="col-size">
                  {formatBytes(finding.totalBytes)}
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
              </tr>
              {expandedId === finding.id && finding.paths.length > 1 && (
                <tr key={`${finding.id}-expanded`} className="expanded-row">
                  <td colSpan={4}>
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
