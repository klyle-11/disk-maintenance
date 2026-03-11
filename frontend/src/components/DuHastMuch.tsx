import { useState, useEffect, useRef } from "react";
import { runDuHastMuch, formatBytes, saveDuHastMuchToHistory, getDuHastMuchHistory } from "../api";
import "./DuHastMuch.css";

interface DuHastMuchProps {
  onScanStart?: () => void;
  onScanComplete?: (result: any) => void;
  initialResult?: any;
}

export function DuHastMuch({ onScanStart, onScanComplete, initialResult }: DuHastMuchProps) {
  const [path, setPath] = useState("");
  const [depth, setDepth] = useState(1);
  const [top, setTop] = useState<number | null>(10);
  const [latest, setLatest] = useState(false);
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentResult, setCurrentResult] = useState<any>(initialResult || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const formatTimeAgo = (mtime: number): string => {
    if (mtime === 0) return "n/a";
    const delta = Date.now() / 1000 - mtime;
    if (delta < 60) return "just now";
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    const days = Math.floor(delta / 86400);
    if (days < 365) return `${days}d ago`;
    return `${Math.floor(days / 365)}y ago`;
  };

  const handleDirectorySelect = async () => {
    if (window.electronAPI) {
      try {
        const selectedPath = await window.electronAPI.selectDirectory();
        if (selectedPath) {
          setPath(selectedPath);
        }
      } catch (err) {
        console.error('Failed to open directory dialog:', err);
        setError('Failed to open directory selection dialog');
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const firstFile = files[0];
      const fullPath = (firstFile as any).path || firstFile.webkitRelativePath;
      if (fullPath) {
        const dirPath = fullPath.substring(0, fullPath.lastIndexOf('\\') || fullPath.lastIndexOf('/'));
        setPath(dirPath || fullPath);
      }
    }
  };

  const makeBar = (fraction: number, width: number = 20): string => {
    const filled = Math.round(fraction * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  };

  const formatCell = (content: string, width: number, align: 'left' | 'right' = 'left'): string => {
    if (align === 'right') {
      return content.padStart(width);
    } else {
      return content.padEnd(width);
    }
  };

  // Load initial result if provided
  useEffect(() => {
    if (initialResult) {
      setCurrentResult(initialResult);
      setPath(initialResult.path || "");
      // Display the initial result
      const resultOutput = formatResultAsOutput(initialResult);
      setOutput(resultOutput);
    }
  }, [initialResult]);

  const handleScan = async () => {
    if (!path.trim()) {
      setError("Please select a directory");
      return;
    }

    setLoading(true);
    setError(null);
    setOutput([]);

    onScanStart?.();

    const lines: string[] = [];
    lines.push("");
    lines.push(`\x1b[1;38;5;177mdu-hast-much\x1b[0m — scanning \x1b[38;5;147m${path}\x1b[0m`);
    lines.push("");
    setOutput([...lines]);

    try {
      const response = await runDuHastMuch({
        path: path.trim(),
        depth,
        top: top || undefined,
        latest,
      });

      if (response.results.length === 0) {
        lines.push("\x1b[33mNo subdirectories found.\x1b[0m");
        setOutput([...lines]);
        return;
      }

      const totalSize = response.totalSize || 0;
      const maxSize = response.results[0]?.size || 1;

      lines.push(latest ? "\x1b[1;38;5;147mRecently Modified Directories\x1b[0m" : "\x1b[1;38;5;147mDisk Usage by Directory\x1b[0m");

      if (latest) {
        lines.push("\x1b[90m┌────┬─────────────────────────────────────────────┬──────────┬────────┬──────────┬──────────────────┐\x1b[0m");
        lines.push("\x1b[90m│ #  │ Directory                                    │ Size     │ Files  │ Avg Size │ Latest Modified  │\x1b[0m");
        lines.push("\x1b[90m├────┼─────────────────────────────────────────────┼──────────┼────────┼──────────┼──────────────────┤\x1b[0m");
      } else {
        lines.push("\x1b[90m┌────┬─────────────────────────────────────────────┬──────────┬─────────┬────────────┐\x1b[0m");
        lines.push("\x1b[90m│ #  │ Directory                                    │ Size     │ % Total │ Usage      │\x1b[0m");
        lines.push("\x1b[90m├────┼─────────────────────────────────────────────┼──────────┼─────────┼────────────┤\x1b[0m");
      }

      response.results.forEach((result, idx) => {
        const num = formatCell(String(idx + 1), 4, 'right');
        const name = result.name.length > 37 ? "..." + result.name.slice(-34) : result.name;
        const namePadded = formatCell(name, 45, 'left');
        const sizeRaw = formatBytes(result.size || 0);
        const sizePadded = formatCell(sizeRaw, 9, 'right');
        const sizeColor = (result.size || 0) > 1024 * 1024 * 1024 ? "\x1b[1;33m" : "";

        if (latest) {
          const filesRaw = String(result.files || 0);
          const filesPadded = formatCell(filesRaw, 8, 'right');
          const avgSizeRaw = formatBytes(result.avg_file_size || 0);
          const avgSizePadded = formatCell(avgSizeRaw, 8, 'right');
          const timeAgoRaw = formatTimeAgo(result.latest_mtime || 0);
          const timeAgoPadded = formatCell(timeAgoRaw, 16, 'left');

          const isSmallFiles = (result.avg_file_size || 0) < 102400 && (result.files || 0) > 50;
          const nameColor = isSmallFiles ? "\x1b[1;31m" : "";

          lines.push(`\x1b[90m│\x1b[0m${num}\x1b[90m│\x1b[0m${nameColor}${namePadded}\x1b[0m\x1b[90m│\x1b[0m${sizeColor}${sizePadded}\x1b[0m\x1b[90m│\x1b[0m${filesPadded}\x1b[90m│\x1b[0m${avgSizePadded}\x1b[90m│\x1b[0m${timeAgoPadded}\x1b[90m│\x1b[0m`);
        } else {
          const pctRaw = totalSize > 0 ? ((result.size || 0) / totalSize * 100).toFixed(1) : "0.0";
          const pctWithPercent = pctRaw + "%";
          const pctPadded = formatCell(pctWithPercent, 8, 'right');
          const fraction = maxSize > 0 ? (result.size || 0) / maxSize : 0;
          const bar = makeBar(fraction, 12);
          const pctColor = parseFloat(pctRaw) > 20 ? "\x1b[1;33m" : "";

          lines.push(`\x1b[90m│\x1b[0m${num}\x1b[90m│\x1b[0m ${namePadded}\x1b[90m│\x1b[0m${sizeColor}${sizePadded}\x1b[0m\x1b[90m│\x1b[0m${pctColor}${pctPadded}\x1b[0m\x1b[90m│\x1b[0m \x1b[38;5;141m${bar}\x1b[0m\x1b[90m│\x1b[0m`);
        }
      });

      if (latest) {
        lines.push("\x1b[90m└────┴─────────────────────────────────────────────┴──────────┴────────┴──────────┴──────────────────┘\x1b[0m");
      } else {
        lines.push("\x1b[90m└────┴─────────────────────────────────────────────┴──────────┴─────────┴────────────┘\x1b[0m");
      }
      lines.push("");

      const totalSizeFormatted = formatBytes(totalSize);
      const totalSizePadded = formatCell(totalSizeFormatted, 9, 'right');

      if (latest) {
        lines.push("\x1b[90m│    │                                             │          │        │          │                  │\x1b[0m");
        lines.push(`\x1b[90m│\x1b[0m \x1b[1;37mTOTAL\x1b[0m                                           \x1b[90m│\x1b[0m${totalSizePadded}\x1b[90m│\x1b[0m        \x1b[90m│\x1b[0m          \x1b[90m│\x1b[0m                  \x1b[90m│\x1b[0m`);
        lines.push("\x1b[90m└────┴─────────────────────────────────────────────┴──────────┴────────┴──────────┴──────────────────┘\x1b[0m");
      } else {
        lines.push("\x1b[90m│    │                                             │          │         │            │\x1b[0m");
        lines.push(`\x1b[90m│\x1b[0m \x1b[1;37mTOTAL\x1b[0m                                           \x1b[90m│\x1b[0m${totalSizePadded}\x1b[90m│\x1b[0m 100.0%  \x1b[90m│\x1b[0m            \x1b[90m│\x1b[0m`);
        lines.push("\x1b[90m└────┴─────────────────────────────────────────────┴──────────┴─────────┴────────────┘\x1b[0m");
      }
      lines.push("");

      const totalFiles = response.totalFiles ?? 0;
      const elapsedSeconds = response.elapsedSeconds ?? 0;
      lines.push(`\x1b[2;38;5;147mTotal: ${formatBytes(totalSize)} across ${totalFiles.toLocaleString()} files · scanned in ${elapsedSeconds.toFixed(1)}s\x1b[0m`);
      lines.push("");

      setOutput([...lines]);

      // Save result to history
      const scanResult = {
        results: response.results,
        total_size: response.totalSize,
        total_files: response.totalFiles,
        elapsed_seconds: response.elapsedSeconds,
        path: path.trim(),
        depth,
        top: top || undefined,
        latest,
        timestamp: Date.now(),
      };
      setCurrentResult(scanResult);
      saveDuHastMuchToHistory(scanResult);
      onScanComplete?.(scanResult);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Scan failed";
      setError(errMsg);
      lines.push(`\x1b[1;31mError:\x1b[0m ${errMsg}`);
      setOutput([...lines]);
    } finally {
      setLoading(false);
    }
  };

  const formatResultAsOutput = (result: any): string[] => {
    const lines: string[] = [];
    lines.push("");
    lines.push(`\x1b[1;38;5;177mdu-hast-much\x1b[0m — scanning \x1b[38;5;147m${result.path || "Unknown"}\x1b[0m`);
    lines.push("");
    lines.push(result.latest ? "\x1b[1;38;5;147mRecently Modified Directories\x1b[0m" : "\x1b[1;38;5;147mDisk Usage by Directory\x1b[0m");

    if (latest) {
      lines.push("\x1b[90m┌────┬─────────────────────────────────────────────┬──────────┬────────┬──────────┬──────────────────┐\x1b[0m");
      lines.push("\x1b[90m│ #  │ Directory                                    │ Size     │ Files  │ Avg Size │ Latest Modified  │\x1b[0m");
      lines.push("\x1b[90m├────┼─────────────────────────────────────────────┼──────────┼────────┼──────────┼──────────────────┤\x1b[0m");
    } else {
      lines.push("\x1b[90m┌────┬─────────────────────────────────────────────┬──────────┬─────────┬────────────┐\x1b[0m");
      lines.push("\x1b[90m│ #  │ Directory                                    │ Size     │ % Total │ Usage      │\x1b[0m");
      lines.push("\x1b[90m├────┼─────────────────────────────────────────────┼──────────┼─────────┼────────────┤\x1b[0m");
    }

    const totalSize = result.total_size || 0;
    const maxSize = result.results?.[0]?.size || 1;

    result.results?.forEach((item: any, idx: number) => {
      const num = formatCell(String(idx + 1), 4, 'right');
      const name = item.name.length > 37 ? "..." + item.name.slice(-34) : item.name;
      const namePadded = formatCell(name, 45, 'left');
      const sizeRaw = formatBytes(item.size || 0);
      const sizePadded = formatCell(sizeRaw, 9, 'right');
      const sizeColor = (item.size || 0) > 1024 * 1024 * 1024 ? "\x1b[1;33m" : "";

      if (result.latest) {
        const filesRaw = String(item.files || 0);
        const filesPadded = formatCell(filesRaw, 8, 'right');
        const avgSizeRaw = formatBytes(item.avg_file_size || 0);
        const avgSizePadded = formatCell(avgSizeRaw, 8, 'right');
        const timeAgoRaw = formatTimeAgo(item.latest_mtime || 0);
        const timeAgoPadded = formatCell(timeAgoRaw, 16, 'left');

        const isSmallFiles = (item.avg_file_size || 0) < 102400 && (item.files || 0) > 50;
        const nameColor = isSmallFiles ? "\x1b[1;31m" : "";

        lines.push(`\x1b[90m│\x1b[0m${num}\x1b[90m│\x1b[0m${nameColor}${namePadded}\x1b[0m\x1b[90m│\x1b[0m${sizeColor}${sizePadded}\x1b[0m\x1b[90m│\x1b[0m${filesPadded}\x1b[90m│\x1b[0m${avgSizePadded}\x1b[90m│\x1b[0m${timeAgoPadded}\x1b[90m│\x1b[0m`);
      } else {
        const pctRaw = totalSize > 0 ? ((item.size || 0) / totalSize * 100).toFixed(1) : "0.0";
        const pctWithPercent = pctRaw + "%";
        const pctPadded = formatCell(pctWithPercent, 8, 'right');
        const fraction = maxSize > 0 ? (item.size || 0) / maxSize : 0;
        const bar = makeBar(fraction, 12);
        const pctColor = parseFloat(pctRaw) > 20 ? "\x1b[1;33m" : "";

        lines.push(`\x1b[90m│\x1b[0m${num}\x1b[90m│\x1b[0m ${namePadded}\x1b[90m│\x1b[0m${sizeColor}${sizePadded}\x1b[0m\x1b[90m│\x1b[0m${pctColor}${pctPadded}\x1b[0m\x1b[90m│\x1b[0m \x1b[38;5;141m${bar}\x1b[0m\x1b[90m│\x1b[0m`);
      }
    });

    if (latest) {
      lines.push("\x1b[90m└────┴─────────────────────────────────────────────┴──────────┴────────┴──────────┴──────────────────┘\x1b[0m");
    } else {
      lines.push("\x1b[90m└────┴─────────────────────────────────────────────┴──────────┴─────────┴────────────┘\x1b[0m");
    }
    lines.push("");

    const totalSizeFormatted = formatBytes(totalSize);
    const totalSizePadded = formatCell(totalSizeFormatted, 9, 'right');

    if (latest) {
      lines.push("\x1b[90m│    │                                             │          │        │          │                  │\x1b[0m");
      lines.push(`\x1b[90m│\x1b[0m \x1b[1;37mTOTAL\x1b[0m                                           \x1b[90m│\x1b[0m${totalSizePadded}\x1b[90m│\x1b[0m        \x1b[90m│\x1b[0m          \x1b[90m│\x1b[0m                  \x1b[90m│\x1b[0m`);
      lines.push("\x1b[90m└────┴─────────────────────────────────────────────┴──────────┴────────┴──────────┴──────────────────┘\x1b[0m");
    } else {
      lines.push("\x1b[90m│    │                                             │          │         │            │\x1b[0m");
      lines.push(`\x1b[90m│\x1b[0m \x1b[1;37mTOTAL\x1b[0m                                           \x1b[90m│\x1b[0m${totalSizePadded}\x1b[90m│\x1b[0m 100.0%  \x1b[90m│\x1b[0m            \x1b[90m│\x1b[0m`);
      lines.push("\x1b[90m└────┴─────────────────────────────────────────────┴──────────┴─────────┴────────────┘\x1b[0m");
    }
    lines.push("");

    const totalFiles = result.total_files || 0;
    const elapsedSeconds = result.elapsed_seconds || 0;
    lines.push(`\x1b[2;38;5;147mTotal: ${formatBytes(totalSize)} across ${totalFiles.toLocaleString()} files · scanned in ${elapsedSeconds.toFixed(1)}s\x1b[0m`);
    lines.push("");

    return lines;
  };

  const renderAnsiLine = (line: string) => {
    const parts: JSX.Element[] = [];
    let key = 0;
    let currentText = "";
    let currentStyle: React.CSSProperties = {};

    const ansiRegex = /\x1b\[([0-9;]*)m/g;
    let lastIndex = 0;
    let match;

    while ((match = ansiRegex.exec(line)) !== null) {
      if (match.index > lastIndex) {
        currentText += line.slice(lastIndex, match.index);
      }

      if (currentText) {
        parts.push(
          <span key={key++} style={currentStyle}>
            {currentText}
          </span>
        );
        currentText = "";
      }

      const codes = match[1].split(";").map(Number);
      codes.forEach((code) => {
        if (code === 0) {
          currentStyle = {};
        } else if (code === 1) {
          currentStyle = { ...currentStyle, fontWeight: "bold" };
        } else if (code === 2) {
          currentStyle = { ...currentStyle, opacity: 0.7 };
        } else if (code >= 30 && code <= 37) {
          const colors = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
          currentStyle = { ...currentStyle, color: colors[code - 30] };
        } else if (code >= 90 && code <= 97) {
          const colors = ["#555", "#f55", "#5f5", "#ff5", "#55f", "#f5f", "#5ff", "#fff"];
          currentStyle = { ...currentStyle, color: colors[code - 90] };
        } else if (code === 38 && codes.length > 2 && codes[1] === 5) {
          // 256-color mode: ESC[38;5;{n}m
          const color256 = codes[2];
          // Map 256-color codes to actual glowing periwinkle colors
          const colorMap: Record<number, string> = {
            141: "#8b7ec8", // Glowing periwinkle for bars
            147: "#9b8ed8", // Bright glowing periwinkle
            177: "#a89ce4", // Light glowing periwinkle
            183: "#b8a4f0", // Extra bright glowing periwinkle
            189: "#c8b4f8", // Ultra bright glowing periwinkle
          };
          if (colorMap[color256]) {
            currentStyle = { ...currentStyle, color: colorMap[color256], fontWeight: "bold" };
          } else {
            // Default fallback for other 256-color codes
            if (color256 < 16) {
              const basicColors = ["black", "maroon", "green", "olive", "navy", "purple", "teal", "silver",
                                   "gray", "red", "lime", "yellow", "blue", "magenta", "cyan", "white"];
              currentStyle = { ...currentStyle, color: basicColors[color256] };
            } else if (color256 >= 232) {
              // Grayscale
              const gray = Math.round((color256 - 232) * 10 + 8);
              currentStyle = { ...currentStyle, color: `rgb(${gray}, ${gray}, ${gray})` };
            }
          }
        }
      });

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < line.length) {
      currentText += line.slice(lastIndex);
    }

    if (currentText) {
      parts.push(
        <span key={key++} style={currentStyle}>
          {currentText}
        </span>
      );
    }

    return parts.length > 0 ? parts : line;
  };

  return (
    <div className="du-hast-much">
      <div className="du-hast-much-header">
        <h2>du-hast-much</h2>
        <span className="du-hast-much-subtitle">Disk usage analyzer with CLI output</span>
      </div>

      <div className="du-hast-much-controls">
        <div className="control-row">
          {!window.electronAPI && (
            <input
              ref={fileInputRef}
              type="file"
              /* @ts-ignore - webkitdirectory is not in TypeScript types */
              webkitdirectory=""
              directory=""
              multiple
              style={{ display: "none" }}
              onChange={handleFileInputChange}
            />
          )}
          <button
            onClick={handleDirectorySelect}
            disabled={loading}
            className="select-directory-button"
          >
            {path ? "Change Directory" : "Select Directory"}
          </button>
          {path && (
            <div className="selected-path" title={path}>
              {path}
            </div>
          )}
          <button
            onClick={handleScan}
            disabled={loading || !path}
            className="scan-button"
          >
            {loading ? "Scanning..." : "Scan"}
          </button>
        </div>

        <div className="control-options">
          <label className="control-option">
            <span>Depth:</span>
            <input
              type="number"
              min="1"
              max="10"
              value={depth}
              onChange={(e) => setDepth(parseInt(e.target.value) || 1)}
              className="number-input"
            />
          </label>

          <label className="control-option">
            <span>Top N:</span>
            <input
              type="number"
              min="1"
              value={top || ""}
              onChange={(e) => setTop(parseInt(e.target.value) || null)}
              placeholder="All"
              className="number-input"
            />
          </label>

          <label className="control-option checkbox">
            <input
              type="checkbox"
              checked={latest}
              onChange={(e) => setLatest(e.target.checked)}
            />
            <span>Sort by Latest Modified</span>
          </label>
        </div>
      </div>

      {error && (
        <div className="du-hast-much-error">
          {error}
        </div>
      )}

      <div className="du-hast-much-output">
        {output.map((line, idx) => (
          <div key={idx} className="cli-line">
            {renderAnsiLine(line)}
          </div>
        ))}
        {loading && output.length === 0 && (
          <div className="cli-line loading">Scanning...</div>
        )}
        {!loading && output.length === 0 && (
          <div className="cli-line placeholder">Select a directory and click Scan to see disk usage</div>
        )}
      </div>
    </div>
  );
}
