import { formatBytes } from "../api";
import type { ExtensionSummary as ExtSummary } from "../api";
import "./ExtensionSummary.css";

interface ExtensionSummaryProps {
  extensions: ExtSummary[];
}

export function ExtensionSummary({ extensions }: ExtensionSummaryProps) {
  if (extensions.length === 0) {
    return (
      <div className="extension-summary empty">
        <p>No extension data available.</p>
      </div>
    );
  }

  // Show top 20 extensions
  const topExtensions = extensions.slice(0, 20);
  const totalSize = extensions.reduce((sum, e) => sum + e.totalBytes, 0);

  return (
    <div className="extension-summary">
      <h3>File Types Summary</h3>
      <p className="summary-note">
        Top {topExtensions.length} extensions by size (total: {formatBytes(totalSize)})
      </p>

      <table className="extension-table">
        <thead>
          <tr>
            <th>Extension</th>
            <th>Files</th>
            <th>Total Size</th>
            <th>% of Total</th>
          </tr>
        </thead>
        <tbody>
          {topExtensions.map((ext) => {
            const percentage = totalSize > 0 ? (ext.totalBytes / totalSize) * 100 : 0;
            return (
              <tr key={ext.extension}>
                <td className="ext-name">{ext.extension}</td>
                <td className="ext-count">{ext.fileCount.toLocaleString()}</td>
                <td className="ext-size">{formatBytes(ext.totalBytes)}</td>
                <td className="ext-percent">
                  <div className="percent-bar-container">
                    <div
                      className="percent-bar"
                      style={{ width: `${Math.min(percentage, 100)}%` }}
                    />
                    <span className="percent-label">{percentage.toFixed(1)}%</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// TODO: Add click to filter findings by extension
// TODO: Add extension-based bulk actions
// TODO: Add chart visualization
