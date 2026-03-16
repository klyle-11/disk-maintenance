import { useState, useEffect, useMemo, useRef } from "react";
import { streamDuHastMuch, formatBytes, saveDuHastMuchToHistory, type DuHastMuchResult } from "../api";
import "./DuHastMuch.css";

interface DuHastMuchProps {
  onScanStart?: () => void;
  onScanComplete?: (result: any) => void;
  initialResult?: any;
}

interface ScanMeta {
  totalSize: number;
  totalFiles: number;
  elapsedSeconds: number;
}

export function DuHastMuch({ onScanStart, onScanComplete, initialResult }: DuHastMuchProps) {
  const [path, setPath] = useState("");
  const [depth, setDepth] = useState(1);
  const [top, setTop] = useState<number | null>(10);
  const [latest, setLatest] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DuHastMuchResult[]>([]);
  const [scanMeta, setScanMeta] = useState<ScanMeta | null>(null);
  const resultsRef = useRef<DuHastMuchResult[]>([]);
  const outputRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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

  const makeBar = (fraction: number, width: number = 20): string => {
    const filled = Math.round(fraction * width);
    return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
  };

  const formatCell = (content: string, width: number, align: 'left' | 'right' = 'left'): string => {
    return align === 'right' ? content.padStart(width) : content.padEnd(width);
  };

  // Auto-scroll output during streaming
  useEffect(() => {
    if (loading && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [results.length, loading]);

  // Load initial result from history
  useEffect(() => {
    if (initialResult?.results) {
      setResults(initialResult.results);
      resultsRef.current = initialResult.results;
      setScanMeta({
        totalSize: initialResult.total_size || 0,
        totalFiles: initialResult.total_files || 0,
        elapsedSeconds: initialResult.elapsed_seconds || 0,
      });
      setPath(initialResult.path || "");
    }
  }, [initialResult]);

  const handleDirectorySelect = async () => {
    if (window.electronAPI) {
      try {
        const selectedPath = await window.electronAPI.selectDirectory();
        if (selectedPath) setPath(selectedPath);
      } catch {
        setError("Failed to open directory selection dialog");
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      // @ts-ignore - webkitRelativePath exists on File
      const rel = files[0].webkitRelativePath;
      if (rel) setPath(rel.split("/")[0]);
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      console.log("[du-hast-much] Scan cancelled by user");
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setLoading(false);
    }
  };

  // Abort any in-flight scan on unmount (page reload, navigation away)
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        console.log("[du-hast-much] Aborting scan on unmount");
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  const handleScan = async () => {
    if (!path.trim()) {
      setError("Please select a directory");
      return;
    }

    // Cancel any existing scan first
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);
    setResults([]);
    setScanMeta(null);
    resultsRef.current = [];
    onScanStart?.();
    console.log(`[du-hast-much] Scan started: ${path.trim()} (depth=${depth}, top=${top}, latest=${latest})`);

    try {
      const summary = await streamDuHastMuch(
        { path: path.trim(), depth, top: top || undefined, latest },
        (result) => {
          resultsRef.current.push(result);
          setResults([...resultsRef.current]);
        },
        controller.signal,
      );

      abortControllerRef.current = null;
      setScanMeta(summary);
      console.log(`[du-hast-much] Scan completed: ${summary.totalFiles} files, ${summary.totalSize} bytes in ${summary.elapsedSeconds.toFixed(1)}s`);

      const scanResult = {
        results: resultsRef.current,
        total_size: summary.totalSize,
        total_files: summary.totalFiles,
        elapsed_seconds: summary.elapsedSeconds,
        path: path.trim(),
        depth,
        top: top || undefined,
        latest,
        timestamp: Date.now(),
      };
      saveDuHastMuchToHistory(scanResult);
      onScanComplete?.(scanResult);
    } catch (err) {
      abortControllerRef.current = null;
      if (err instanceof Error && err.message === "Scan cancelled") {
        return; // Don't show error for user-initiated cancellation
      }
      const msg = err instanceof Error ? err.message : "Scan failed";
      console.error(`[du-hast-much] Scan error: ${msg}`);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Build ANSI output lines reactively from accumulated results
  const output = useMemo(() => {
    const lines: string[] = [];

    if (results.length === 0 && !loading) return lines;

    lines.push("");
    lines.push(`\x1b[1;38;5;177mdu-hast-much\x1b[0m \u2014 ${loading ? "scanning" : "scanned"} \x1b[38;5;147m${path}\x1b[0m`);
    lines.push("");

    if (results.length === 0) return lines;

    // Sort: frontend owns sort order since streaming delivers results as-discovered
    const sorted = [...results].sort(
      latest
        ? (a, b) => b.latest_mtime - a.latest_mtime
        : (a, b) => b.size - a.size
    );

    const displayed = top ? sorted.slice(0, top) : sorted;
    const totalSize = scanMeta?.totalSize ?? results.reduce((sum, r) => sum + r.size, 0);
    const maxSize = displayed[0]?.size || 1;

    // Table title
    lines.push(latest ? "\x1b[1;38;5;147mRecently Modified Directories\x1b[0m" : "\x1b[1;38;5;147mDisk Usage by Directory\x1b[0m");

    // Table header
    if (latest) {
      lines.push("\x1b[90m\u250c\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510\x1b[0m");
      lines.push("\x1b[90m\u2502 #  \u2502 Directory                                    \u2502 Size     \u2502 Files  \u2502 Avg Size \u2502 Latest Modified  \u2502\x1b[0m");
      lines.push("\x1b[90m\u251c\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524\x1b[0m");
    } else {
      lines.push("\x1b[90m\u250c\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510\x1b[0m");
      lines.push("\x1b[90m\u2502 #  \u2502 Directory                                    \u2502 Size     \u2502 % Total \u2502 Usage      \u2502\x1b[0m");
      lines.push("\x1b[90m\u251c\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524\x1b[0m");
    }

    // Table rows
    displayed.forEach((result, idx) => {
      const num = formatCell(String(idx + 1), 4, 'right');
      const name = result.name.length > 37 ? "..." + result.name.slice(-34) : result.name;
      const namePadded = formatCell(name, 45, 'left');
      const sizePadded = formatCell(formatBytes(result.size || 0), 9, 'right');
      const sizeColor = (result.size || 0) > 1024 * 1024 * 1024 ? "\x1b[1;33m" : "";

      if (latest) {
        const filesPadded = formatCell(String(result.files || 0), 8, 'right');
        const avgSizePadded = formatCell(formatBytes(result.avg_file_size || 0), 8, 'right');
        const timeAgoPadded = formatCell(formatTimeAgo(result.latest_mtime || 0), 16, 'left');
        const isSmallFiles = (result.avg_file_size || 0) < 102400 && (result.files || 0) > 50;
        const nameColor = isSmallFiles ? "\x1b[1;31m" : "";

        lines.push(`\x1b[90m\u2502\x1b[0m${num}\x1b[90m\u2502\x1b[0m${nameColor}${namePadded}\x1b[0m\x1b[90m\u2502\x1b[0m${sizeColor}${sizePadded}\x1b[0m\x1b[90m\u2502\x1b[0m${filesPadded}\x1b[90m\u2502\x1b[0m${avgSizePadded}\x1b[90m\u2502\x1b[0m${timeAgoPadded}\x1b[90m\u2502\x1b[0m`);
      } else {
        const pctRaw = totalSize > 0 ? ((result.size || 0) / totalSize * 100).toFixed(1) : "0.0";
        const pctPadded = formatCell(pctRaw + "%", 8, 'right');
        const fraction = maxSize > 0 ? (result.size || 0) / maxSize : 0;
        const bar = makeBar(fraction, 12);
        const pctColor = parseFloat(pctRaw) > 20 ? "\x1b[1;33m" : "";

        lines.push(`\x1b[90m\u2502\x1b[0m${num}\x1b[90m\u2502\x1b[0m ${namePadded}\x1b[90m\u2502\x1b[0m${sizeColor}${sizePadded}\x1b[0m\x1b[90m\u2502\x1b[0m${pctColor}${pctPadded}\x1b[0m\x1b[90m\u2502\x1b[0m \x1b[38;5;141m${bar}\x1b[0m\x1b[90m\u2502\x1b[0m`);
      }
    });

    // Table bottom border
    if (latest) {
      lines.push("\x1b[90m\u2514\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518\x1b[0m");
    } else {
      lines.push("\x1b[90m\u2514\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518\x1b[0m");
    }
    lines.push("");

    // TOTAL row
    const totalSizePadded = formatCell(formatBytes(totalSize), 9, 'right');
    if (latest) {
      lines.push("\x1b[90m\u2502    \u2502                                             \u2502          \u2502        \u2502          \u2502                  \u2502\x1b[0m");
      lines.push(`\x1b[90m\u2502\x1b[0m \x1b[1;37mTOTAL\x1b[0m                                           \x1b[90m\u2502\x1b[0m${totalSizePadded}\x1b[90m\u2502\x1b[0m        \x1b[90m\u2502\x1b[0m          \x1b[90m\u2502\x1b[0m                  \x1b[90m\u2502\x1b[0m`);
      lines.push("\x1b[90m\u2514\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518\x1b[0m");
    } else {
      lines.push("\x1b[90m\u2502    \u2502                                             \u2502          \u2502         \u2502            \u2502\x1b[0m");
      lines.push(`\x1b[90m\u2502\x1b[0m \x1b[1;37mTOTAL\x1b[0m                                           \x1b[90m\u2502\x1b[0m${totalSizePadded}\x1b[90m\u2502\x1b[0m 100.0%  \x1b[90m\u2502\x1b[0m            \x1b[90m\u2502\x1b[0m`);
      lines.push("\x1b[90m\u2514\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518\x1b[0m");
    }
    lines.push("");

    // Summary line
    if (scanMeta) {
      lines.push(`\x1b[2;38;5;147mTotal: ${formatBytes(totalSize)} across ${scanMeta.totalFiles.toLocaleString()} files \u00b7 scanned in ${scanMeta.elapsedSeconds.toFixed(1)}s\x1b[0m`);
    } else if (loading) {
      const runningTotal = results.reduce((sum, r) => sum + r.size, 0);
      const runningFiles = results.reduce((sum, r) => sum + r.files, 0);
      lines.push(`\x1b[2;38;5;147mScanning\u2026 ${results.length} directories \u00b7 ${formatBytes(runningTotal)} \u00b7 ${runningFiles.toLocaleString()} files\x1b[0m`);
    }
    lines.push("");

    return lines;
  }, [results, scanMeta, loading, path, latest, top]);

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
        parts.push(<span key={key++} style={currentStyle}>{currentText}</span>);
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
          const color256 = codes[2];
          const colorMap: Record<number, string> = {
            141: "#8b7ec8",
            147: "#9b8ed8",
            177: "#a89ce4",
            183: "#b8a4f0",
            189: "#c8b4f8",
          };
          if (colorMap[color256]) {
            currentStyle = { ...currentStyle, color: colorMap[color256], fontWeight: "bold" };
          } else {
            if (color256 < 16) {
              const basicColors = ["black", "maroon", "green", "olive", "navy", "purple", "teal", "silver",
                                   "gray", "red", "lime", "yellow", "blue", "magenta", "cyan", "white"];
              currentStyle = { ...currentStyle, color: basicColors[color256] };
            } else if (color256 >= 232) {
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
      parts.push(<span key={key++} style={currentStyle}>{currentText}</span>);
    }

    return parts.length > 0 ? parts : line;
  };

  const pathLabel = path
    ? (path.length > 40 ? "\u2026" + path.slice(-39) : path)
    : "select folder";

  return (
    <div className="du-hast-much">
      <div className="dhm-toolbar">
        <h2 className="dhm-title">du-hast-much</h2>

        <span
          className="dhm-path"
          onClick={handleDirectorySelect}
          title={path || "Select a folder to scan"}
        >
          {pathLabel}
        </span>

        <label className="dhm-control">
          <span>depth</span>
          <input
            type="number"
            min="1"
            max="10"
            value={depth}
            onChange={(e) => setDepth(parseInt(e.target.value) || 1)}
          />
        </label>

        <label className="dhm-control">
          <span>top</span>
          <input
            type="number"
            min="1"
            value={top || ""}
            onChange={(e) => setTop(parseInt(e.target.value) || null)}
            placeholder="all"
          />
        </label>

        <label className="dhm-control dhm-checkbox">
          <input
            type="checkbox"
            checked={latest}
            onChange={(e) => setLatest(e.target.checked)}
          />
          <span>latest</span>
        </label>

        {loading ? (
          <span className="dhm-action" onClick={handleCancel}>
            stop
          </span>
        ) : (
          <span className="dhm-action" onClick={handleScan}>
            scan
          </span>
        )}
      </div>

      {!window.electronAPI && (
        <input
          ref={fileInputRef}
          type="file"
          /* @ts-ignore - webkitdirectory is not in TypeScript types */
          webkitdirectory=""
          directory=""
          style={{ display: "none" }}
          onChange={handleFileInputChange}
        />
      )}

      {error && <div className="du-hast-much-error">{error}</div>}

      <div className="du-hast-much-output" ref={outputRef}>
        {output.map((line, idx) => (
          <div key={idx} className="cli-line">
            {renderAnsiLine(line)}
          </div>
        ))}
        {loading && results.length === 0 && (
          <div className="cli-line loading">Scanning\u2026</div>
        )}
        {!loading && results.length === 0 && !scanMeta && (
          <div className="cli-line placeholder">Select a folder and scan to see disk usage</div>
        )}
      </div>
    </div>
  );
}
