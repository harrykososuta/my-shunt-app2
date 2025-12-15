// src/App.jsx
// ShuntFlow Analytics - v1.0.7
// Changes:
// 1) Move graphComment overlay -> BELOW chart
// 2) Add stenosis logic (corr/lag/simultaneous peaks) + classification
// 3) Add "parameter explanation" button -> popup modal
// 4) Add alert pickup section (TAWSS/OSI/RRT/PressureProxy)
// 5) Add "most dangerous frames (top ~3)" captured during analysis -> shown only when Check pressed
// 6) Keep prior crash fixes (RAF/interval cleanup + mounted guards)

import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import {
  Upload, Play, Pause, RotateCcw, Activity, AlertCircle, FileVideo, Crosshair,
  Download, Settings, Ruler, Scan, Eye, Zap, Move3d, MousePointer2, TrendingUp,
  Maximize2, X, Sliders, Eraser, Undo, ZoomIn, ZoomOut, RefreshCw, Move, Camera, Info
} from 'lucide-react';
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

const ShuntWSSAnalyzer = () => {
  const [videoSrc, setVideoSrc] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // --- 解析設定 ---
  const [config, setConfig] = useState({
    colorThreshold: 40,
    wallThreshold: 50,
    stressMultiplier: 2.5,
    sectorCount: 36,
    roiFlow: null,
    roiVessel: null,
    scalePxPerCm: 0,
  });

  // --- UI状態 ---
  const [toolMode, setToolMode] = useState('none');
  const [showSettings, setShowSettings] = useState(false);
  const [calibPoints, setCalibPoints] = useState([]);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  // --- 3Dビュー操作・設定 ---
  const [rot3D, setRot3D] = useState({ x: 0.5, y: 0.5 });
  const [pan3D, setPan3D] = useState({ x: 0, y: 0 });
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [isDragging3D, setIsDragging3D] = useState(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const [noiseFilterLevel, setNoiseFilterLevel] = useState(1);
  const [is3DModalOpen, setIs3DModalOpen] = useState(false);
  const modalContainerRef = useRef(null);
  const [modalSize, setModalSize] = useState({ w: 800, h: 600 });

  // interactionMode: 'rotate' | 'move' | 'delete'
  const [interactionMode, setInteractionMode] = useState('rotate');
  const [selectionBox, setSelectionBox] = useState(null);
  const [historyStack, setHistoryStack] = useState([]);

  // --- 解析結果 ---
  const [sectorResults, setSectorResults] = useState([]);
  const [timeSeriesData, setTimeSeriesData] = useState([]);
  const [analysisStatus, setAnalysisStatus] = useState('待機中');
  const [diagnosticText, setDiagnosticText] = useState([]);
  const [bullseyeComment, setBullseyeComment] = useState('解析待機中...');
  const [graphComment, setGraphComment] = useState('');
  const [currentFrameCount, setCurrentFrameCount] = useState(0);
  const [realtimeMetrics, setRealtimeMetrics] = useState({ avg: 0, max: 0, area: 0, evaluation: '-' });
  const [modalData, setModalData] = useState(null);
  const [graphMode, setGraphMode] = useState('tawss_osi');

  // --- 新規：狭窄判定 ---
  const [stenosisResult, setStenosisResult] = useState(null);
  const [showParamExplain, setShowParamExplain] = useState(false);

  // --- 新規：アラート/危険フレーム ---
  const [alertPickups, setAlertPickups] = useState([]);
  const [dangerFrames, setDangerFrames] = useState([]); // [{frame, timeSec, score, img}]
  const dangerFramesRef = useRef([]); // in-flight top3 during analysis

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const bullseyeRef = useRef(null);
  const stackCanvasRef = useRef(null);
  const stackCanvasLargeRef = useRef(null);
  const modalCanvasRef = useRef(null);
  const animationRef = useRef(null);
  const containerRef = useRef(null);

  // refs for heavy updates
  const frameCountRef = useRef(0);
  const metricsRef = useRef({ avg: 0, max: 0, area: 0, evaluation: '-' });
  const timeSeriesRef = useRef([]);
  const uiTimerRef = useRef(null);

  // ✅ mounted guard（StrictModeなどで一瞬unmountされてもsetStateしない）
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ✅ グラフ幅
  const graphBoxRef = useRef(null);
  const [graphW, setGraphW] = useState(0);

  useLayoutEffect(() => {
    const el = graphBoxRef.current;
    if (!el) return;

    const measure = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      setGraphW(w > 10 ? w : 0);
    };

    measure();

    const ro = new ResizeObserver(() => {
      if (isPlaying) return;
      measure();
    });

    ro.observe(el);
    window.addEventListener('resize', measure);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [isPlaying]);

  const makeSectorAccumulator = (n) =>
    Array(n).fill(0).map(() => ({
      sumSignedWss: 0,
      sumAbsWss: 0,
      count: 0,
      maxWss: 0,
      maxFrame: 0,
      minWss: 0,
      minFrame: 0
    }));

  const accumulationRef = useRef({
    sectors: makeSectorAccumulator(36),
    centroid: { x: 0, y: 0 },
    stackBuffer: []
  });

  const safeCancelRAF = () => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  };

  // ✅ 追加：コンポーネントが外れる時に完全停止（insertBefore系クラッシュ予防）
  useEffect(() => {
    return () => {
      safeCancelRAF();

      if (uiTimerRef.current) {
        clearInterval(uiTimerRef.current);
        uiTimerRef.current = null;
      }

      if (videoRef.current) {
        try {
          videoRef.current.pause();
        } catch (_) {}
      }
    };
  }, []);

  // ✅ FIX 1: 解析中は「重いグラフデータ(timeSeriesData)」をStateに入れない
  useEffect(() => {
    if (!isPlaying) {
      if (uiTimerRef.current) {
        clearInterval(uiTimerRef.current);
        uiTimerRef.current = null;
      }
      return;
    }

    uiTimerRef.current = setInterval(() => {
      if (!mountedRef.current) return;

      setCurrentFrameCount(frameCountRef.current);
      setRealtimeMetrics({ ...metricsRef.current });
    }, 250);

    return () => {
      if (uiTimerRef.current) {
        clearInterval(uiTimerRef.current);
        uiTimerRef.current = null;
      }
    };
  }, [isPlaying]);

  // ---------------------------
  // Utilities (JS版：狭窄ロジック)
  // ---------------------------
  const mean = (arr) => {
    const v = arr.filter((x) => Number.isFinite(x));
    if (!v.length) return 0;
    return v.reduce((a, b) => a + b, 0) / v.length;
  };

  const std = (arr) => {
    const v = arr.filter((x) => Number.isFinite(x));
    if (v.length < 2) return 0;
    const m = mean(v);
    const s2 = v.reduce((acc, x) => acc + (x - m) * (x - m), 0) / (v.length - 1);
    return Math.sqrt(s2);
  };

  const pearsonCorr = (a, b) => {
    const n = Math.min(a.length, b.length);
    const xa = [];
    const xb = [];
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
        xa.push(a[i]);
        xb.push(b[i]);
      }
    }
    if (xa.length < 3) return 0;
    const ma = mean(xa);
    const mb = mean(xb);
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < xa.length; i++) {
      const va = xa[i] - ma;
      const vb = xb[i] - mb;
      num += va * vb;
      da += va * va;
      db += vb * vb;
    }
    const den = Math.sqrt(da * db);
    return den > 1e-9 ? num / den : 0;
  };

  // naive cross-correlation lag (full) -> returns lagIndex where b is "after" a if positive
  const crossCorrelationLagIndex = (a, b) => {
    const n = Math.min(a.length, b.length);
    const xa = a.slice(0, n).map((x) => (Number.isFinite(x) ? x : 0));
    const xb = b.slice(0, n).map((x) => (Number.isFinite(x) ? x : 0));
    const ma = mean(xa);
    const mb = mean(xb);
    const aa = xa.map((x) => x - ma);
    const bb = xb.map((x) => x - mb);

    // lags from -(n-1) ... +(n-1)
    let bestLag = 0;
    let bestVal = -Infinity;

    for (let lag = -(n - 1); lag <= (n - 1); lag++) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const j = i + lag;
        if (j < 0 || j >= n) continue;
        sum += aa[i] * bb[j];
      }
      if (sum > bestVal) {
        bestVal = sum;
        bestLag = lag;
      }
    }
    return bestLag;
  };

  const detectLocalPeaksIdx = (arr) => {
    const peaks = [];
    for (let i = 1; i < arr.length - 1; i++) {
      const x = arr[i];
      if (!Number.isFinite(x)) continue;
      const p = arr[i - 1];
      const n = arr[i + 1];
      if (Number.isFinite(p) && Number.isFinite(n) && x >= p && x >= n) peaks.push(i);
    }
    return peaks;
  };

  const computeTrendFeatures = (pressureProxyArr, wssArr, timeArr) => {
    // align by finite values (simple mask)
    const p = [];
    const w = [];
    const t = [];
    const n = Math.min(pressureProxyArr.length, wssArr.length, timeArr.length);
    for (let i = 0; i < n; i++) {
      const pv = pressureProxyArr[i];
      const wv = wssArr[i];
      const tv = timeArr[i];
      if (Number.isFinite(pv) && Number.isFinite(wv) && Number.isFinite(tv)) {
        p.push(pv);
        w.push(wv);
        t.push(tv);
      }
    }
    if (p.length < 3) {
      return { corr: 0, lagSec: 0, simPeaks: 0 };
    }
    const corr = pearsonCorr(p, w);
    let dt = 0;
    if (t.length >= 2) {
      const diffs = [];
      for (let i = 1; i < t.length; i++) {
        const d = t[i] - t[i - 1];
        if (Number.isFinite(d) && d > 0) diffs.push(d);
      }
      diffs.sort((a, b) => a - b);
      dt = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;
    }
    if (!dt || dt <= 0) dt = 0.2; // fallback (sampling interval guess)

    const lagIdx = crossCorrelationLagIndex(p, w);
    const lagSec = lagIdx * dt;

    const peaksW = detectLocalPeaksIdx(w);
    const peaksP = detectLocalPeaksIdx(p);
    const simPeaks = peaksW.reduce((acc, pw) => {
      const hit = peaksP.some((pp) => Math.abs(pp - pw) <= 1);
      return acc + (hit ? 1 : 0);
    }, 0);

    return { corr, lagSec, simPeaks };
  };

  const classifyStenosisJS = (feat, refStats = null) => {
    const sim = feat.simPeaks ?? 0;
    const lag = feat.lagSec ?? 0;
    const corr = feat.corr ?? 0;

    const corrScore = Math.abs(corr);
    const lagScore = Math.abs(lag);

    let mildScore = null;
    if (refStats) {
      const z = (x, m, s) => (s && s > 0 ? (x - m) / s : 0);
      const zSim = z(sim, refStats.sim_peak_mean, refStats.sim_peak_std);
      const zLag = z(lag, refStats.lag_mean, refStats.lag_std);
      const zCorr = (corrScore - 0.3) / 0.2;
      mildScore = zSim + zLag + zCorr * 0.5;
    }

    let category = "狭窄なし";
    let rule = "";

    if (sim >= 50 || lagScore >= 0.8 || corrScore >= 0.3) {
      if (sim >= 70 || lagScore >= 1.5) {
        category = "中等度狭窄疑い";
        rule = `sim高め(${sim}) or lag大(${lag.toFixed(2)}s) → 中等度疑い`;
      } else {
        category = "軽度狭窄疑い";
        rule = `sim=${sim}, lag=${lag.toFixed(2)}s, corr=${corr.toFixed(2)} で軽度疑い`;
      }
    }
    if ((sim >= 80 && lagScore >= 2.0) || corrScore >= 0.75) {
      category = "高度狭窄疑い";
      rule = `強い異常性: sim=${sim}, lag=${lag.toFixed(2)}s, corr=${corr.toFixed(2)} → 高度疑い`;
    }

    if (mildScore !== null) {
      if (category === "狭窄なし" && mildScore > 1.0) {
        category = "軽度狭窄疑い（スコア補正）";
        rule += `; mild_score=${mildScore.toFixed(2)} 補正`;
      } else if (category.startsWith("軽度狭窄") && mildScore > 2.0) {
        category = "中等度狭窄疑い（スコア補正）";
        rule += `; mild_score=${mildScore.toFixed(2)} 補正`;
      }
    }

    if (!rule) rule = `sim=${sim}, lag=${lag.toFixed(2)}s, corr=${corr.toFixed(2)} で初期分類`;

    return {
      category,
      ruleUsed: rule,
      mildSuspicionScore: mildScore
    };
  };

  const refStats = useMemo(() => ({
    sim_peak_mean: 50.0,
    sim_peak_std: 15.0,
    lag_mean: 1.5,
    lag_std: 1.0,
  }), []);

  const stenosisIcon = (cat) => {
    if (!cat) return "⚪️";
    if (cat.startsWith("高度")) return "🔴";
    if (cat.startsWith("中等度")) return "🟠";
    if (cat.startsWith("軽度")) return "🟡";
    if (cat.startsWith("狭窄なし")) return "🟢";
    return "⚪️";
  };

  const resetAnalysis = () => {
    safeCancelRAF();

    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      } catch (_) {}
    }

    setIsPlaying(false);
    setAnalysisStatus('待機中');
    setSectorResults([]);
    setTimeSeriesData([]);
    setDiagnosticText([]);
    setBullseyeComment('解析待機中...');
    setGraphComment('');
    setCurrentFrameCount(0);
    setRealtimeMetrics({ avg: 0, max: 0, area: 0, evaluation: '-' });
    setModalData(null);
    setCalibPoints([]);
    setHistoryStack([]);
    setZoomLevel(1.0);
    setRot3D({ x: 0.5, y: 0.5 });
    setPan3D({ x: 0, y: 0 });
    setInteractionMode('rotate');

    // new
    setStenosisResult(null);
    setShowParamExplain(false);
    setAlertPickups([]);
    setDangerFrames([]);
    dangerFramesRef.current = [];

    frameCountRef.current = 0;
    metricsRef.current = { avg: 0, max: 0, area: 0, evaluation: '-' };
    timeSeriesRef.current = [];

    accumulationRef.current = {
      sectors: makeSectorAccumulator(config.sectorCount),
      centroid: { x: 0, y: 0 },
      stackBuffer: []
    };

    [bullseyeRef, stackCanvasRef, stackCanvasLargeRef].forEach(ref => {
      if (ref.current) {
        const ctx = ref.current.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, ref.current.width, ref.current.height);
      }
    });

    requestAnimationFrame(renderOverlay);
  };

  const handleFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoSrc(url);
      setConfig(prev => ({ ...prev, roiFlow: null, roiVessel: null, scalePxPerCm: 0 }));
    }
  };

  const handleVideoLoaded = () => {
    resetAnalysis();
    if (videoRef.current && canvasRef.current) {
      requestAnimationFrame(renderOverlay);
    }
  };

  const handleSave3DImage = () => {
    const canvas = stackCanvasLargeRef.current;
    if (!canvas) return;
    const image = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = image;
    link.download = `3d_vessel_model_${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}.png`;
    link.click();
  };

  const renderOverlay = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    if (video.videoWidth > 0 && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    const w = canvas.width;
    const h = canvas.height;

    if (!isPlaying) {
      try {
        ctx.drawImage(video, 0, 0, w, h);
      } catch (_) {}
    }

    const drawROI = (roi, color, label) => {
      if (!roi) return;
      const rx = roi.x * w;
      const ry = roi.y * h;
      const rw = roi.w * w;
      const rh = roi.h * h;

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.globalAlpha = 1.0;

      ctx.font = '12px sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(label, rx, Math.max(12, ry - 5));
    };

    drawROI(config.roiFlow, '#ef4444', '解析ROI');
    drawROI(config.roiVessel, '#10b981', '血管形状ROI');

    if (toolMode === 'calibration') {
      ctx.strokeStyle = '#ffff00';
      ctx.lineWidth = 2;
      ctx.fillStyle = '#ffff00';

      calibPoints.forEach((p, idx) => {
        const px = p.x * w; const py = p.y * h;
        ctx.beginPath();
        ctx.moveTo(px - 5, py - 5); ctx.lineTo(px + 5, py + 5);
        ctx.moveTo(px + 5, py - 5); ctx.lineTo(px - 5, py + 5);
        ctx.stroke();
        ctx.fillText(`P${idx + 1}`, px + 8, py);
      });

      if (calibPoints.length === 1 && mousePos) {
        ctx.beginPath();
        ctx.moveTo(calibPoints[0].x * w, calibPoints[0].y * h);
        ctx.lineTo(mousePos.x * w, mousePos.y * h);
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }, [config.roiFlow, config.roiVessel, toolMode, calibPoints, isPlaying, mousePos]);

  useEffect(() => { requestAnimationFrame(renderOverlay); }, [renderOverlay]);

  const handleMouseDown = (e) => {
    if (toolMode === 'none' || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    if (toolMode === 'calibration') {
      const newPoints = [...calibPoints, { x: nx, y: ny }];
      setCalibPoints(newPoints);

      if (newPoints.length === 2 && videoRef.current?.videoWidth > 0) {
        const dx = (newPoints[0].x - newPoints[1].x) * videoRef.current.videoWidth;
        const dy = (newPoints[0].y - newPoints[1].y) * videoRef.current.videoHeight;
        setConfig(p => ({ ...p, scalePxPerCm: Math.sqrt(dx * dx + dy * dy) }));
        setCalibPoints([]);
        setToolMode('none');
      }
    } else if (toolMode.startsWith('roi')) {
      const target = toolMode === 'roi-flow' ? 'roiFlow' : 'roiVessel';
      setConfig(p => ({ ...p, [target]: { x: nx, y: ny, w: 0, h: 0 }, isDragging: true, dragTarget: target }));
    }
  };

  const handleMouseMove = (e) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    setMousePos({ x: nx, y: ny });

    if (config.isDragging) {
      setConfig(p => ({
        ...p,
        [p.dragTarget]: { ...p[p.dragTarget], w: nx - p[p.dragTarget].x, h: ny - p[p.dragTarget].y }
      }));
    }
  };

  const handleMouseUp = () => {
    if (config.isDragging) {
      setConfig(p => {
        const t = p.dragTarget;
        let { x, y, w, h } = p[t];
        if (w < 0) { x += w; w = Math.abs(w); }
        if (h < 0) { y += h; h = Math.abs(h); }
        return { ...p, [t]: w < 0.01 || h < 0.01 ? null : { x, y, w, h }, isDragging: false, dragTarget: null };
      });
      setToolMode('none');
    }
  };

  useEffect(() => {
    if (is3DModalOpen && modalContainerRef.current) {
      const updateSize = () => {
        const rect = modalContainerRef.current.getBoundingClientRect();
        setModalSize({ w: rect.width, h: rect.height });
      };
      updateSize();
      window.addEventListener('resize', updateSize);
      return () => window.removeEventListener('resize', updateSize);
    }
  }, [is3DModalOpen]);

  const handle3DMouseDown = (e) => {
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;

    if (is3DModalOpen && interactionMode === 'delete') {
      setSelectionBox({ sx: x, sy: y, cx: x, cy: y });
    } else {
      setIsDragging3D(true);
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handle3DMouseMove = (e) => {
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;

    if (is3DModalOpen && interactionMode === 'delete' && selectionBox) {
      setSelectionBox(prev => ({ ...prev, cx: x, cy: y }));
      requestAnimationFrame(() => {
        drawStack(accumulationRef.current.stackBuffer, stackCanvasLargeRef.current, true);
      });
      return;
    }

    if (!isDragging3D) return;
    const deltaX = e.clientX - lastMouseRef.current.x;
    const deltaY = e.clientY - lastMouseRef.current.y;

    if (interactionMode === 'rotate') {
      setRot3D(prev => ({ x: prev.x + deltaY * 0.01, y: prev.y + deltaX * 0.01 }));
    } else if (interactionMode === 'move') {
      setPan3D(prev => ({ x: prev.x + deltaX, y: prev.y + deltaY }));
    }

    lastMouseRef.current = { x: e.clientX, y: e.clientY };

    requestAnimationFrame(() => {
      drawStack(accumulationRef.current.stackBuffer, stackCanvasRef.current, false);
      if (is3DModalOpen) drawStack(accumulationRef.current.stackBuffer, stackCanvasLargeRef.current, true);
    });
  };

  const handle3DMouseUp = () => {
    if (is3DModalOpen && interactionMode === 'delete' && selectionBox) {
      deleteSelectedPoints();
      setSelectionBox(null);
    }
    setIsDragging3D(false);
  };

  const handleWheel = (e) => {
    if (!is3DModalOpen) return;
    const scaleFactor = 1.1;
    setZoomLevel(prev => e.deltaY < 0 ? Math.min(prev * scaleFactor, 5.0) : Math.max(prev / scaleFactor, 0.2));
  };

  const drawStack = useCallback((buffer, canvas, isLarge) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const w = canvas.width, h = canvas.height;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    if (buffer.length === 0) {
      ctx.fillStyle = '#475569';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText("No Vessel Shape Data", w / 2, h / 2);
      return;
    }

    const cx = w / 2 + (isLarge ? pan3D.x : 0);
    const cy = h / 2 + (isLarge ? pan3D.y : 0);
    const scale = isLarge ? zoomLevel : 0.5;

    const visibleCount = isLarge ? 300 : 100;
    const showFrames = buffer.slice(-visibleCount);

    const rotate = (x, y, z, ax, ay) => {
      let y1 = y * Math.cos(ax) - z * Math.sin(ax);
      let z1 = y * Math.sin(ax) + z * Math.cos(ax);
      let x2 = x * Math.cos(ay) + z1 * Math.sin(ay);
      let z2 = -x * Math.sin(ay) + z1 * Math.cos(ay);
      return { x: x2, y: y1, z: z2 };
    };

    const hasNeighbor = (p, currentSliceIdx) => {
      if (noiseFilterLevel === 0) return true;
      const range = noiseFilterLevel * 3;

      if (currentSliceIdx > 0) {
        const prevSlice = showFrames[currentSliceIdx - 1];
        for (let pp of prevSlice.vesselPoints) {
          if (Math.abs(pp.x - p.x) < range && Math.abs(pp.y - p.y) < range) return true;
        }
      }
      if (currentSliceIdx < showFrames.length - 1) {
        const nextSlice = showFrames[currentSliceIdx + 1];
        for (let np of nextSlice.vesselPoints) {
          if (Math.abs(np.x - p.x) < range && Math.abs(np.y - p.y) < range) return true;
        }
      }
      return false;
    };

    showFrames.forEach((slice, idx) => {
      const zBase = (idx - showFrames.length / 2) * (isLarge ? 3 : 2);
      const alphaBase = 0.2 + (idx / showFrames.length) * 0.8;

      ctx.strokeStyle = `rgba(200, 230, 255, ${alphaBase * 0.5})`;
      ctx.lineWidth = 0.5;
      ctx.fillStyle = `rgba(220, 240, 255, ${alphaBase})`;

      const projectedPoints = [];

      slice.vesselPoints.forEach(p => {
        if (!hasNeighbor(p, idx)) return;

        const r = rotate(p.x, p.y, zBase, rot3D.x, rot3D.y);
        const perspective = 400 / (400 - r.z);
        const px = cx + r.x * scale * perspective;
        const py = cy + r.y * scale * perspective;

        projectedPoints.push({ x: px, y: py, z: r.z });

        const size = isLarge ? 1.5 * perspective : 1.2;
        ctx.fillRect(px, py, size, size);
      });

      if (isLarge && idx > 0 && idx % 2 === 0) {
        ctx.beginPath();
        projectedPoints.forEach((p, pIdx) => {
          if (pIdx > 0 && Math.abs(p.x - projectedPoints[pIdx - 1].x) < 10 && Math.abs(p.y - projectedPoints[pIdx - 1].y) < 10) {
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(projectedPoints[pIdx - 1].x, projectedPoints[pIdx - 1].y);
          }
        });
        ctx.stroke();
      }
    });

    if (isLarge && interactionMode === 'delete' && selectionBox) {
      const { sx, sy, cx, cy } = selectionBox;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(sx, sy, cx - sx, cy - sy);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
      ctx.fillRect(sx, sy, cx - sx, cy - sy);
    }

    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w - 30, h - 30);
    ctx.lineTo(w - 10, h - 30);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px sans-serif';
    ctx.fillText('X', w - 10, h - 35);

    ctx.beginPath();
    ctx.moveTo(w - 30, h - 30);
    ctx.lineTo(w - 30, h - 10);
    ctx.stroke();
    ctx.fillText('Y', w - 35, h - 10);
  }, [rot3D, pan3D, noiseFilterLevel, interactionMode, selectionBox, zoomLevel]);

  useEffect(() => {
    drawStack(accumulationRef.current.stackBuffer, stackCanvasRef.current, false);
    if (is3DModalOpen) drawStack(accumulationRef.current.stackBuffer, stackCanvasLargeRef.current, true);
  }, [drawStack, is3DModalOpen]);

  const deleteSelectedPoints = () => {
    if (!selectionBox || !stackCanvasLargeRef.current) return;

    const { sx, sy, cx, cy } = selectionBox;
    const minX = Math.min(sx, cx), maxX = Math.max(sx, cx);
    const minY = Math.min(sy, cy), maxY = Math.max(sy, cy);

    const canvas = stackCanvasLargeRef.current;
    const w = canvas.width, h = canvas.height;
    const centerX = w / 2 + pan3D.x;
    const centerY = h / 2 + pan3D.y;
    const scale = zoomLevel;

    const currentBuffer = accumulationRef.current.stackBuffer;
    setHistoryStack(prev => [...prev.slice(-4), JSON.parse(JSON.stringify(currentBuffer))]);

    const rotate = (x, y, z, ax, ay) => {
      let y1 = y * Math.cos(ax) - z * Math.sin(ax);
      let z1 = y * Math.sin(ax) + z * Math.cos(ax);
      let x2 = x * Math.cos(ay) + z1 * Math.sin(ay);
      let z2 = -x * Math.sin(ay) + z1 * Math.cos(ay);
      return { x: x2, y: y1, z: z2 };
    };

    const showFrames = currentBuffer.slice(-300);
    const bufferLength = showFrames.length;

    const newBuffer = currentBuffer.map(slice => {
      const idx = showFrames.findIndex(s => s.frame === slice.frame);
      if (idx === -1) return slice;

      const zBase = (idx - bufferLength / 2) * 3;

      const newVesselPoints = slice.vesselPoints.filter(p => {
        const r = rotate(p.x, p.y, zBase, rot3D.x, rot3D.y);
        const perspective = 400 / (400 - r.z);
        const px = centerX + r.x * scale * perspective;
        const py = centerY + r.y * scale * perspective;
        return !(px >= minX && px <= maxX && py >= minY && py <= maxY);
      });

      return { ...slice, vesselPoints: newVesselPoints };
    });

    accumulationRef.current.stackBuffer = newBuffer;
    drawStack(newBuffer, stackCanvasLargeRef.current, true);
  };

  const handleUndo = () => {
    if (historyStack.length === 0) return;
    const prev = historyStack[historyStack.length - 1];
    accumulationRef.current.stackBuffer = prev;
    setHistoryStack(prevStack => prevStack.slice(0, -1));
    drawStack(prev, stackCanvasLargeRef.current, true);
  };

  const updateTopDangerFrames = (candidate) => {
    // candidate: {frame, timeSec, score, img}
    const cur = dangerFramesRef.current ? [...dangerFramesRef.current] : [];
    cur.push(candidate);
    cur.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    // dedupe by frame
    const dedup = [];
    const seen = new Set();
    for (const c of cur) {
      if (seen.has(c.frame)) continue;
      seen.add(c.frame);
      dedup.push(c);
      if (dedup.length >= 3) break;
    }
    dangerFramesRef.current = dedup;
  };

  const processFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    if (video.paused || video.ended) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    if (canvas.width !== video.videoWidth && video.videoWidth > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    const w = canvas.width;
    const h = canvas.height;

    ctx.drawImage(video, 0, 0, w, h);

    if (config.roiFlow) {
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(config.roiFlow.x * w, config.roiFlow.y * h, config.roiFlow.w * w, config.roiFlow.h * h);
    }
    if (config.roiVessel) {
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(config.roiVessel.x * w, config.roiVessel.y * h, config.roiVessel.w * w, config.roiVessel.h * h);
    }

    const frameData = ctx.getImageData(0, 0, w, h);
    const data = frameData.data;

    let vesselPoints = [];
    let frameTotalStress = 0;
    let frameMaxStress = 0;
    let frameStressPixels = 0;

    const getIndex = (x, y) => (y * w + x) * 4;

    const getFlowVector = (r, g, b) => {
      const isRed = r > g + config.colorThreshold && r > b + config.colorThreshold;
      const isBlue = b > g + config.colorThreshold && b > r + config.colorThreshold;
      return isRed ? { dir: 1, val: r } : isBlue ? { dir: -1, val: b } : { dir: 0, val: 0 };
    };

    let roiVx = 0, roiVy = 0;
    if (config.roiVessel) {
      const sx = Math.floor(config.roiVessel.x * w), sy = Math.floor(config.roiVessel.y * h);
      const ex = Math.floor((config.roiVessel.x + config.roiVessel.w) * w), ey = Math.floor((config.roiVessel.y + config.roiVessel.h) * h);
      roiVx = (sx + ex) / 2; roiVy = (sy + ey) / 2;

      for (let y = sy; y < ey; y += 2) {
        for (let x = sx; x < ex; x += 2) {
          const i = getIndex(x, y);
          const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;

          if (brightness > config.wallThreshold) {
            let isInnerWall = false;
            const checkRange = 3;

            for (let oy = -checkRange; oy <= checkRange; oy += 2) {
              for (let ox = -checkRange; ox <= checkRange; ox += 2) {
                if (ox === 0 && oy === 0) continue;
                const nx = x + ox, ny = y + oy;
                if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

                const ni = getIndex(nx, ny);
                const nb = (data[ni] + data[ni + 1] + data[ni + 2]) / 3;
                if (nb < config.wallThreshold * 0.8) { isInnerWall = true; break; }
              }
              if (isInnerWall) break;
            }

            if (isInnerWall) vesselPoints.push({ x: x - roiVx, y: y - roiVy });
          }
        }
      }
    }

    let startX = 0, startY = 0, endX = w, endY = h;
    if (config.roiFlow) {
      startX = Math.floor(config.roiFlow.x * w); startY = Math.floor(config.roiFlow.y * h);
      endX = Math.floor((config.roiFlow.x + config.roiFlow.w) * w);
      endY = Math.floor((config.roiFlow.y + config.roiFlow.h) * h);
    }
    startX = Math.max(0, startX); startY = Math.max(0, startY);
    endX = Math.min(w, endX); endY = Math.min(h, endY);

    let flowSumX = 0, flowSumY = 0, flowCount = 0;

    const overlayData = ctx.createImageData(w, h);
    const output = overlayData.data;

    for (let y = startY + 1; y < endY - 1; y++) {
      for (let x = startX + 1; x < endX - 1; x++) {
        const i = getIndex(x, y);
        const flow = getFlowVector(data[i], data[i + 1], data[i + 2]);

        if (flow.dir !== 0) {
          flowSumX += x; flowSumY += y; flowCount++;
        } else {
          let maxVel = 0, maxDir = 0;
          const neighbors = [getIndex(x + 1, y), getIndex(x - 1, y), getIndex(x, y + 1), getIndex(x, y - 1)];

          for (let ni of neighbors) {
            const nf = getFlowVector(data[ni], data[ni + 1], data[ni + 2]);
            if (nf.val > maxVel) { maxVel = nf.val; maxDir = nf.dir; }
          }

          if (maxVel > 0) {
            const stress = Math.min(255, maxVel * (maxVel / 255 * config.stressMultiplier));

            frameTotalStress += stress;
            if (stress > frameMaxStress) frameMaxStress = stress;
            frameStressPixels++;

            const cx = accumulationRef.current.centroid.x || w / 2;
            const cy = accumulationRef.current.centroid.y || h / 2;

            let angle = Math.atan2(y - cy, x - cx) * (180 / Math.PI);
            if (angle < 0) angle += 360;

            const sIdx = Math.floor(angle / (360 / config.sectorCount)) % config.sectorCount;
            const sec = accumulationRef.current.sectors[sIdx];
            if (sec) {
              sec.sumAbsWss += stress;
              sec.sumSignedWss += stress * maxDir;
              sec.count++;
              if (stress > sec.maxWss) { sec.maxWss = stress; sec.maxFrame = frameCountRef.current; }
            }

            const oIdx = getIndex(x, y);
            if (stress < 100) {
              output[oIdx] = stress * 2.5; output[oIdx + 1] = 255; output[oIdx + 2] = 0;
            } else {
              output[oIdx] = 255; output[oIdx + 1] = 255 - (stress - 100) * 1.6; output[oIdx + 2] = 0;
            }
            output[oIdx + 3] = 255;
          }
        }
      }
    }

    if (flowCount > 0) {
      accumulationRef.current.centroid = { x: flowSumX / flowCount, y: flowSumY / flowCount };
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w; tempCanvas.height = h;
    const tctx = tempCanvas.getContext('2d');
    if (tctx) {
      tctx.putImageData(overlayData, 0, 0);
      ctx.globalAlpha = 1.0;
      ctx.drawImage(tempCanvas, 0, 0);
    }

    frameCountRef.current += 1;

    if (frameCountRef.current % 2 === 0) {
      const sb = accumulationRef.current.stackBuffer;
      sb.push({ frame: frameCountRef.current, vesselPoints });
      if (sb.length > 120) sb.splice(0, sb.length - 120);

      drawStack(sb, stackCanvasRef.current, false);
      if (is3DModalOpen) drawStack(sb, stackCanvasLargeRef.current, true);
    }

    let areaVal = flowCount;
    let unit = 'px²';
    if (config.scalePxPerCm > 0) {
      areaVal = flowCount / (config.scalePxPerCm ** 2);
      unit = 'cm²';
    }

    const avg = frameStressPixels > 0 ? frameTotalStress / frameStressPixels : 0;

    // sampling (timeSeries)
    if (frameCountRef.current % 6 === 0) {
      const evalLabel = avg > 80 ? 'HIGH' : avg > 40 ? 'WARN' : 'NORM';
      metricsRef.current = {
        avg: Math.round(avg),
        max: Math.round(frameMaxStress),
        area: `${areaVal.toFixed(2)} ${unit}`,
        evaluation: evalLabel
      };

      const timeSec = Number.isFinite(video.currentTime) ? video.currentTime : (timeSeriesRef.current.length * 0.2);

      // "pressure proxy": areaVal (same as before, but explicitly stored)
      const pressureProxy = areaVal;

      const next = [...timeSeriesRef.current, {
        frame: frameCountRef.current,
        timeSec: Number(timeSec.toFixed(3)),
        avgWss: Number(avg.toFixed(1)),
        area: Number(areaVal.toFixed(3)),          // used by chart (existing)
        pressureProxy: Number(pressureProxy.toFixed(3)), // new explicit field
      }];
      timeSeriesRef.current = next.length > 260 ? next.slice(-260) : next;

      // update top danger frames (keep ~3)
      // score: WSS (dominant) + pressureProxy (scaled)  ※簡易スコア
      const pressureScale = (config.scalePxPerCm > 0) ? 40 : 0.8;
      const score = (avg * 1.0) + (pressureProxy * pressureScale);

      // capture occasionally to avoid heavy memory usage
      // capture only if it's potentially high risk
      const maybeHigh = avg > 55 || (pressureProxy > mean(timeSeriesRef.current.map(d => d.pressureProxy)) + std(timeSeriesRef.current.map(d => d.pressureProxy)));
      if (maybeHigh) {
        try {
          const img = canvas.toDataURL('image/jpeg', 0.72);
          updateTopDangerFrames({
            frame: frameCountRef.current,
            timeSec,
            score,
            img
          });
        } catch (_) {
          // ignore capture errors
        }
      }
    }

    animationRef.current = requestAnimationFrame(processFrame);
  }, [config, drawStack, is3DModalOpen]);

  const buildAlertPickups = (results, ts) => {
    const pickups = [];

    // 1) High TAWSS
    const highT = results.filter(r => r.tawss > 80);
    if (highT.length) {
      const max = highT.reduce((p, c) => p.tawss > c.tawss ? p : c);
      pickups.push({
        type: 'warning',
        title: 'TAWSS High',
        desc: `${Math.round(max.angle)}°付近で高ストレス（TAWSS=${max.tawss.toFixed(1)}）`,
        frameLabel: `F${max.maxFrame || '-'}`,
      });
    }

    // 2) High OSI
    const highO = results.filter(r => r.osi > 0.20);
    if (highO.length) {
      const max = highO.reduce((p, c) => p.osi > c.osi ? p : c);
      pickups.push({
        type: 'warning',
        title: 'OSI High',
        desc: `${Math.round(max.angle)}°付近でOSI高値（OSI=${max.osi.toFixed(3)}）`,
        frameLabel: '-',
      });
    }

    // 3) High RRT
    const highR = results.filter(r => r.rrt > 0.5);
    if (highR.length) {
      const max = highR.reduce((p, c) => p.rrt > c.rrt ? p : c);
      pickups.push({
        type: 'danger',
        title: 'RRT High',
        desc: `${Math.round(max.angle)}°付近で滞留リスク（RRT=${max.rrt.toFixed(3)}）`,
        frameLabel: '-',
      });
    }

    // 4) Pressure proxy (area) anomaly / low compliance
    if (ts.length >= 6) {
      const p = ts.map(d => d.pressureProxy);
      const minP = Math.min(...p);
      const maxP = Math.max(...p);
      const dist = minP > 0 ? (maxP - minP) / minP : 0;

      const m = mean(p);
      const s = std(p);
      const spikes = ts.filter(d => d.pressureProxy > m + 1.5 * s);
      if (spikes.length) {
        const last = spikes[spikes.length - 1];
        pickups.push({
          type: 'warning',
          title: 'PressureProxy Spike',
          desc: `PressureProxy（面積）が上振れ（例: F${last.frame}, P=${last.pressureProxy.toFixed(3)}）`,
          frameLabel: `F${last.frame}`,
        });
      }

      if (dist < 0.1) {
        pickups.push({
          type: 'warning',
          title: 'Low Compliance',
          desc: `拍動変動が小さく、伸展性低下の可能性（ΔP/P≈${dist.toFixed(2)}）`,
          frameLabel: '-',
        });
      }
    }

    return pickups.length ? pickups : [{ type: 'success', title: 'Normal', desc: 'アラート所見なし', frameLabel: '-' }];
  };

  const finalizeAnalysis = () => {
    safeCancelRAF();
    setIsPlaying(false);
    setAnalysisStatus('完了');

    const acc = accumulationRef.current;
    const step = 360 / config.sectorCount;

    const results = acc.sectors.map((s, i) => {
      if (s.count === 0) return { angle: i * step, tawss: 0, osi: 0, rrt: 0, maxWss: 0, maxFrame: 0 };
      const tawss = s.sumAbsWss / s.count;
      const osi = s.sumAbsWss > 0 ? 0.5 * (1 - Math.abs(s.sumSignedWss) / s.sumAbsWss) : 0;
      const den = (1 - 2 * osi) * tawss;
      return {
        angle: i * step,
        tawss: parseFloat(tawss.toFixed(2)),
        osi: parseFloat(osi.toFixed(3)),
        rrt: parseFloat((den > 0.01 ? 1 / den : 100).toFixed(3)),
        maxWss: s.maxWss,
        maxFrame: s.maxFrame
      };
    });

    setSectorResults(results);

    setCurrentFrameCount(frameCountRef.current);
    setRealtimeMetrics({ ...metricsRef.current });
    setTimeSeriesData([...timeSeriesRef.current]);

    // freeze danger frames captured
    setDangerFrames([...dangerFramesRef.current]);

    drawBullseye(results);

    // generate comments + existing diagnostics (kept) + new stenosis logic + new pickups
    generateDiagnostics(results, timeSeriesRef.current);

    const ts = timeSeriesRef.current;
    if (ts.length >= 3) {
      const wssArr = ts.map(d => d.avgWss);
      const pArr = ts.map(d => d.pressureProxy);
      const tArr = ts.map(d => d.timeSec);
      const feat = computeTrendFeatures(pArr, wssArr, tArr);
      const cls = classifyStenosisJS(feat, refStats);
      setStenosisResult({ feat, cls });
    } else {
      setStenosisResult(null);
    }

    setAlertPickups(buildAlertPickups(results, timeSeriesRef.current));
  };

  const togglePlay = () => {
    if (!videoRef.current) return;

    safeCancelRAF();
    if (uiTimerRef.current) {
      clearInterval(uiTimerRef.current);
      uiTimerRef.current = null;
    }

    if (isPlaying) {
      try {
        videoRef.current.pause();
      } catch (_) {}
      setIsPlaying(false);
      setAnalysisStatus('停止中');
      return;
    }

    if (analysisStatus === '完了') resetAnalysis();

    setAnalysisStatus('解析中');
    setIsPlaying(true);

    videoRef.current.play()
      .then(() => {
        if (!mountedRef.current) return;
        animationRef.current = requestAnimationFrame(processFrame);
      })
      .catch((e) => {
        console.error("video.play failed:", e);
        if (!mountedRef.current) return;
        setIsPlaying(false);
        setAnalysisStatus('エラー');
      });
  };

  const handleVideoEnded = () => {
    finalizeAnalysis();
  };

  const generateDiagnostics = (results, ts) => {
    const list = [];

    const highWss = results.filter(r => r.tawss > 80);
    let bComment = "特記すべき高WSS領域なし";
    if (highWss.length > 0) {
      const peak = highWss.reduce((p, c) => p.tawss > c.tawss ? p : c);
      bComment = `${Math.round(peak.angle)}°付近が高WSSです`;
      let dir = "";
      const ang = (peak.angle % 360 + 360) % 360;
      if (ang >= 315 || ang < 45) dir = "(右側)";
      else if (ang >= 45 && ang < 135) dir = "(下側)";
      else if (ang >= 135 && ang < 225) dir = "(左側)";
      else dir = "(上側)";
      bComment += ` ${dir}`;
    }
    setBullseyeComment(bComment);

    const avgAll = results.reduce((sum, r) => sum + r.tawss, 0) / results.length;
    let gComment = avgAll > 60 ? "全体的にWSSが高い傾向。" : "平均的なWSSレベル。";

    if (ts.length > 0) {
      const areas = ts.map(d => d.area);
      const minA = Math.min(...areas);
      const maxA = Math.max(...areas);
      const distensibility = minA > 0 ? (maxA - minA) / minA : 0;
      if (distensibility < 0.1) gComment += " 血管壁の伸展性が低下している可能性があります(Low Compliance)。";
      else gComment += " 良好な拍動変動が見られます。";
    }
    setGraphComment(gComment);

    const high = results.filter(r => r.tawss > 80 && r.osi < 0.2);
    if (high.length) {
      const max = high.reduce((p, c) => p.tawss > c.tawss ? p : c);
      list.push({ type: 'warning', title: 'High Shear', desc: `${Math.round(max.angle)}°付近で高ストレス`, frameLabel: `F${max.maxFrame}`, rawFrame: max.maxFrame });
    }

    const low = results.filter(r => r.rrt > 0.5);
    if (low.length) {
      const max = low.reduce((p, c) => p.rrt > c.rrt ? p : c);
      list.push({ type: 'danger', title: 'Stagnation', desc: `${Math.round(max.angle)}°付近で滞留リスク`, frameLabel: '-', rawFrame: null });
    }

    setDiagnosticText(list.length ? list : [{ type: 'success', title: 'Normal', desc: '異常なし' }]);
  };

  const drawBullseye = (results) => {
    const cvs = bullseyeRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    const w = cvs.width, h = cvs.height, cx = w / 2, cy = h / 2, r = w / 2 - 20;
    ctx.clearRect(0, 0, w, h);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;

    for (let i = 0; i < 12; i++) {
      const rad = (i * 30 - 90) * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r);
      ctx.stroke();
    }

    ctx.beginPath(); ctx.arc(cx, cy, r * 0.66, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.33, 0, Math.PI * 2); ctx.stroke();

    results.forEach(s => {
      const sa = (s.angle - 90) * Math.PI / 180;
      const ea = (s.angle + (360 / config.sectorCount) - 90) * Math.PI / 180;
      const val = Math.min(s.tawss * 2, 255);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, sa, ea);
      ctx.closePath();

      ctx.fillStyle = val < 128
        ? `rgb(${val * 2},255,0)`
        : `rgb(255,${255 - (val - 128) * 2},0)`;

      ctx.fill();

      if (s.osi > 0.15) {
        ctx.fillStyle = `rgba(0,0,0,${s.osi * 1.5})`;
        ctx.fill();
      }
    });

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    [[0, '0°(R)'], [90, '90°(B)'], [180, '180°(L)'], [270, '270°(T)']].forEach(([deg, txt]) => {
      const rad = (deg - 90) * Math.PI / 180;
      ctx.fillText(txt, cx + Math.cos(rad) * (r + 12), cy + Math.sin(rad) * (r + 12));
    });
  };

  const handleDownloadCSV = () => {
    if (!sectorResults.length) return;
    const head = ['Angle', 'TAWSS', 'OSI', 'RRT', 'MaxWSS', 'MaxFrame'];
    const rows = sectorResults.map(r => [r.angle, r.tawss, r.osi, r.rrt, r.maxWss, r.maxFrame].join(','));
    const blob = new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shunt_data.csv';
    a.click();
  };

  const openFrameModal = (diag) => {
    if (diag?.rawFrame && videoRef.current) {
      setModalData(diag);
      const dur = videoRef.current.duration;
      const total = frameCountRef.current;
      if (total > 0 && Number.isFinite(dur) && dur > 0) {
        videoRef.current.currentTime = (diag.rawFrame / total) * dur;
      }
    }
  };

  useEffect(() => {
    if (modalData && modalCanvasRef.current && videoRef.current) {
      const v = videoRef.current;
      const c = modalCanvasRef.current;
      c.width = v.videoWidth;
      c.height = v.videoHeight;

      const draw = () => {
        const ctx = c.getContext('2d');
        if (ctx) ctx.drawImage(v, 0, 0, c.width, c.height);
      };

      if (v.seeking) v.addEventListener('seeked', draw, { once: true });
      else draw();
    }
  }, [modalData]);

  const openDangerFramesModal = () => {
    if (!dangerFrames.length) return;
    setModalData({
      type: 'dangerFrames',
      title: '危険フレーム（上位3）',
      frames: dangerFrames
    });
  };

  const stenosisSummaryText = useMemo(() => {
    if (!stenosisResult?.cls) return "解析後に表示されます";
    const { category } = stenosisResult.cls;
    // 例に合わせて「中等度狭窄を示す」形式
    if (category.startsWith("中等度")) return "中等度狭窄を示す";
    if (category.startsWith("高度")) return "高度狭窄を示す";
    if (category.startsWith("軽度")) return "軽度狭窄を示す";
    if (category.startsWith("狭窄なし")) return "狭窄なしを示す";
    return category;
  }, [stenosisResult]);

  const relationshipLine = useMemo(() => {
    if (!stenosisResult?.feat) return "TAWSS×PressureProxy の関係: 解析待機中";
    const { corr, lagSec, simPeaks } = stenosisResult.feat;
    return `TAWSS×PressureProxy の関係: corr=${corr.toFixed(2)} / lag=${lagSec.toFixed(2)}s / sim=${simPeaks}`;
  }, [stenosisResult]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between border-b border-slate-700 pb-4 gap-4">
        <div className="flex items-center gap-3">
          <Activity className="text-blue-400 w-8 h-8" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">ShuntFlow <span className="text-blue-400">Pro</span></h1>
            <p className="text-xs text-slate-500">TAWSS / OSI / Compliance / 3D-Vessel</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700 mr-2">
            <button
              onClick={() => setToolMode(toolMode === 'calibration' ? 'none' : 'calibration')}
              className={`p-2 rounded hover:bg-slate-700 relative ${toolMode === 'calibration' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}
              title="キャリブレーション"
            >
              <Ruler className="w-5 h-5" />
              {config.scalePxPerCm > 0 && <span className="absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full"></span>}
            </button>

            <button
              onClick={() => setToolMode(toolMode === 'roi-flow' ? 'none' : 'roi-flow')}
              className={`p-2 rounded hover:bg-slate-700 relative ${toolMode === 'roi-flow' ? 'bg-red-600 text-white' : 'text-slate-400'}`}
              title="解析ROI (血流)"
            >
              <Zap className="w-5 h-5" />
              {config.roiFlow && <span className="absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full"></span>}
            </button>

            <button
              onClick={() => setToolMode(toolMode === 'roi-vessel' ? 'none' : 'roi-vessel')}
              className={`p-2 rounded hover:bg-slate-700 relative ${toolMode === 'roi-vessel' ? 'bg-emerald-600 text-white' : 'text-slate-400'}`}
              title="形状ROI (血管壁抽出)"
            >
              <Scan className="w-5 h-5" />
              {config.roiVessel && <span className="absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full"></span>}
            </button>

            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-2 rounded hover:bg-slate-700 ${showSettings ? 'bg-slate-600 text-white' : 'text-slate-400'}`}
              title="設定"
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>

          <button
            onClick={handleDownloadCSV}
            disabled={!sectorResults.length}
            className="p-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white disabled:opacity-30 border border-slate-700"
            title="CSVダウンロード"
          >
            <Download className="w-5 h-5" />
          </button>

          <label className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg cursor-pointer text-sm font-medium transition-colors">
            <Upload className="w-4 h-4" /> 動画読込
            <input type="file" accept="video/*" onChange={handleFileUpload} className="hidden" />
          </label>
        </div>
      </header>

      {showSettings && (
        <div className="mb-6 bg-slate-800 p-4 rounded-xl border border-slate-600 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-in fade-in slide-in-from-top-2">
          <div>
            <label className="text-xs text-slate-400 block mb-2">Color Threshold (血流感度): {config.colorThreshold}</label>
            <input
              type="range" min="10" max="100"
              value={config.colorThreshold}
              onChange={(e) => setConfig({ ...config, colorThreshold: Number(e.target.value) })}
              className="w-full accent-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-2">Wall Threshold (壁輝度): {config.wallThreshold}</label>
            <input
              type="range" min="10" max="200"
              value={config.wallThreshold}
              onChange={(e) => setConfig({ ...config, wallThreshold: Number(e.target.value) })}
              className="w-full accent-emerald-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-2">Stress Multiplier (WSS強調): {config.stressMultiplier}</label>
            <input
              type="range" min="0.5" max="5.0" step="0.1"
              value={config.stressMultiplier}
              onChange={(e) => setConfig({ ...config, stressMultiplier: Number(e.target.value) })}
              className="w-full accent-orange-500"
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 space-y-4">
          <div
            ref={containerRef}
            className={`bg-black rounded-xl overflow-hidden shadow-2xl border border-slate-700 relative aspect-video flex items-center justify-center group ${toolMode === 'none' ? 'cursor-default' : 'cursor-crosshair'}`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            {!videoSrc ? (
              <div className="text-center text-slate-500">
                <FileVideo className="w-16 h-16 mx-auto mb-2 opacity-50" />
                <p>動画を選択してください</p>
              </div>
            ) : (
              <>
                <video
                  ref={videoRef}
                  src={videoSrc}
                  className="hidden"
                  muted
                  playsInline
                  onEnded={handleVideoEnded}
                  onLoadedData={handleVideoLoaded}
                />
                <canvas ref={canvasRef} className="w-full h-full object-contain pointer-events-none" />

                {toolMode === 'calibration' && (
                  <div className="absolute top-4 bg-blue-600/90 text-white px-3 py-1 rounded-full text-xs shadow-lg pointer-events-none">
                    1cmの両端をクリック
                  </div>
                )}
                {toolMode === 'roi-flow' && (
                  <div className="absolute top-4 bg-red-600/90 text-white px-3 py-1 rounded-full text-xs shadow-lg pointer-events-none">
                    血流解析範囲をドラッグ
                  </div>
                )}
                {toolMode === 'roi-vessel' && (
                  <div className="absolute top-4 bg-emerald-600/90 text-white px-3 py-1 rounded-full text-xs shadow-lg pointer-events-none">
                    血管形状範囲をドラッグ (3D用)
                  </div>
                )}

                <div className="absolute bottom-4 left-4 flex flex-col gap-2 pointer-events-none">
                  <div className="bg-black/60 backdrop-blur-sm px-3 py-1 rounded border border-white/10 text-xs text-white flex items-center gap-2">
                    <Crosshair className="w-3 h-3 text-yellow-400" /> {analysisStatus} F:{currentFrameCount}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-4 bg-slate-800 p-4 rounded-xl border border-slate-700">
            <button
              onClick={togglePlay}
              disabled={!videoSrc}
              className={`flex-1 py-3 rounded-lg flex items-center justify-center gap-2 transition-all font-bold ${
                !videoSrc
                  ? 'bg-slate-700 text-slate-500'
                  : isPlaying
                    ? 'bg-red-500 hover:bg-red-600 text-white'
                    : analysisStatus === '完了'
                      ? 'bg-green-600 hover:bg-green-500 text-white'
                      : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              {(() => {
                const Icon = isPlaying ? Pause : (analysisStatus === '完了' ? RotateCcw : Play);
                const label = isPlaying ? '停止' : (analysisStatus === '完了' ? '再解析' : '解析開始');
                const key = isPlaying ? 'pause' : (analysisStatus === '完了' ? 're' : 'play');
                return (
                  <span className="inline-flex items-center gap-2" key={key}>
                    <Icon className="w-5 h-5" />
                    {label}
                  </span>
                );
              })()}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 flex flex-col items-center relative min-h-[220px]">
              <h3 className="text-slate-400 text-xs font-bold uppercase mb-2 w-full text-left">Bullseye Plot</h3>
              <div className="flex w-full items-start gap-2">
                <div className="relative w-32 h-32 flex-shrink-0">
                  <canvas ref={bullseyeRef} width={200} height={200} className="w-full h-full object-contain" />
                </div>
                <div className="flex-1 text-[10px] text-slate-400 space-y-2">
                  <div className="text-blue-300 font-bold border-b border-slate-700 pb-1 mb-1">
                    {bullseyeComment}
                  </div>
                  <div className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-500"></span> High WSS</div>
                  <div className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-green-500"></span> Low</div>
                  <div className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-black border border-slate-600"></span> High OSI</div>
                  <div className="border-t border-slate-700 pt-1 mt-1">
                    R: 0°, B: 90°, L: 180°, T: 270°
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 flex flex-col items-center relative min-h-[220px]">
              <h3 className="text-slate-400 text-xs font-bold uppercase mb-2 w-full text-left flex items-center justify-between">
                <span className="flex items-center gap-2"><Move3d className="w-3 h-3" /> 3D Vessel</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIs3DModalOpen(true)}
                    className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white"
                    title="拡大表示"
                  >
                    <Maximize2 className="w-3 h-3" />
                  </button>
                  <span className="text-[9px] text-slate-500 flex items-center gap-1"><MousePointer2 className="w-3 h-3" /> Drag</span>
                </div>
              </h3>

              <div
                className="relative w-full h-32 bg-slate-900 rounded border border-slate-700 overflow-hidden cursor-move"
                onMouseDown={handle3DMouseDown}
                onMouseMove={handle3DMouseMove}
                onMouseUp={handle3DMouseUp}
                onMouseLeave={handle3DMouseUp}
              >
                <canvas ref={stackCanvasRef} width={300} height={200} className="w-full h-full object-contain" />
              </div>

              <div className="w-full mt-2 flex items-center gap-2">
                <Sliders className="w-3 h-3 text-slate-500" />
                <span className="text-[9px] text-slate-500">Filter:</span>
                <input
                  type="range" min="0" max="3" step="1"
                  value={noiseFilterLevel}
                  onChange={(e) => setNoiseFilterLevel(Number(e.target.value))}
                  className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                />
                <span className="text-[9px] text-slate-400">{['Off', 'Low', 'Med', 'High'][noiseFilterLevel]}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-7 space-y-6">
          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-slate-400 text-sm font-medium flex items-center gap-2">
                <Activity className="w-4 h-4" /> Analytic Graphs
              </h3>
              <div className="flex bg-slate-900 rounded-lg p-1 gap-1">
                <button onClick={() => setGraphMode('tawss_osi')} className={`px-3 py-1 text-xs rounded transition-colors ${graphMode === 'tawss_osi' ? 'bg-slate-700 text-white font-bold' : 'text-slate-500 hover:text-slate-300'}`}>TAWSS & OSI</button>
                <button onClick={() => setGraphMode('wss_pressure')} className={`px-3 py-1 text-xs rounded transition-colors ${graphMode === 'wss_pressure' ? 'bg-slate-700 text-white font-bold' : 'text-slate-500 hover:text-slate-300'}`}>WSS & Area</button>
                <button onClick={() => setGraphMode('rrt')} className={`px-3 py-1 text-xs rounded transition-colors ${graphMode === 'rrt' ? 'bg-slate-700 text-white font-bold' : 'text-slate-500 hover:text-slate-300'}`}>RRT</button>
              </div>
            </div>

            {/* 1. TAWSSとOSIの関係の表示（チャート） */}
            <div className="flex-1 min-h-0 min-w-0 relative">
              <div ref={graphBoxRef} className="w-full min-w-0 relative" style={{ height: 280, minHeight: 260 }}>
                {isPlaying && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-800/80 backdrop-blur-sm transition-opacity duration-300">
                    <span className="text-slate-400 text-xs animate-pulse">解析中…（グラフ描画を停止して安定化）</span>
                  </div>
                )}

                <div
                  className="w-full h-full transition-opacity duration-300"
                  style={{
                    visibility: isPlaying ? 'hidden' : 'visible',
                    opacity: isPlaying ? 0 : 1,
                  }}
                >
                  {graphW > 0 ? (
                    <div className="w-full h-full">
                      {graphMode === 'wss_pressure' ? (
                        <ComposedChart width={graphW} height={280} data={timeSeriesData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                          <XAxis dataKey="frame" stroke="#64748b" tick={{ fontSize: 10 }} label={{ value: 'Frame', position: 'insideBottom', offset: -5, fontSize: 10 }} />
                          <YAxis yAxisId="left" stroke="#3b82f6" label={{ value: 'Avg WSS', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#3b82f6' }} tick={{ fontSize: 10 }} />
                          <YAxis yAxisId="right" orientation="right" stroke="#10b981" label={{ value: `Area (${config.scalePxPerCm > 0 ? 'cm²' : 'px²'})`, angle: 90, position: 'insideRight', fontSize: 10, fill: '#10b981' }} tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                          <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155' }} />
                          <Legend verticalAlign="top" height={36} />
                          <Line yAxisId="left" type="monotone" dataKey="avgWss" stroke="#3b82f6" strokeWidth={2} name="Avg WSS" dot={false} isAnimationActive={false} />
                          <Area yAxisId="right" type="monotone" dataKey="area" stroke="#10b981" fill="rgba(16,185,129,0.2)" name="Vessel Area (Pressure Proxy)" isAnimationActive={false} />
                        </ComposedChart>
                      ) : graphMode === 'rrt' ? (
                        <ComposedChart width={graphW} height={280} data={sectorResults}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                          <XAxis dataKey="angle" stroke="#64748b" tick={{ fontSize: 10 }} label={{ value: 'Angle', position: 'insideBottom', offset: -5, fontSize: 10 }} />
                          <YAxis stroke="#ef4444" label={{ value: 'RRT', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#ef4444' }} tick={{ fontSize: 10 }} />
                          <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155' }} />
                          <Legend verticalAlign="top" height={36} />
                          <Area type="monotone" dataKey="rrt" stroke="#ef4444" fill="rgba(239,68,68,0.2)" name="Relative Residence Time" isAnimationActive={false} />
                        </ComposedChart>
                      ) : (
                        <ComposedChart width={graphW} height={280} data={sectorResults}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                          <XAxis dataKey="angle" stroke="#64748b" tick={{ fontSize: 10 }} label={{ value: 'Angle', position: 'insideBottom', offset: -5, fontSize: 10 }} />
                          <YAxis yAxisId="left" stroke="#3b82f6" label={{ value: 'TAWSS', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#3b82f6' }} tick={{ fontSize: 10 }} />
                          <YAxis yAxisId="right" orientation="right" stroke="#f59e0b" label={{ value: 'OSI', angle: 90, position: 'insideRight', fontSize: 10, fill: '#f59e0b' }} tick={{ fontSize: 10 }} domain={[0, 0.5]} />
                          <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155' }} />
                          <Legend verticalAlign="top" height={36} />
                          <Area yAxisId="left" type="monotone" dataKey="tawss" stroke="#3b82f6" fill="rgba(59,130,246,0.2)" name="TAWSS" isAnimationActive={false} />
                          <Line yAxisId="right" type="monotone" dataKey="osi" stroke="#f59e0b" strokeWidth={2} dot={false} name="OSI" isAnimationActive={false} />
                        </ComposedChart>
                      )}
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-500 text-xs">
                      Chart preparing...
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ここから：指定の順序でチャートの「下」に配置 */}
            <div className="mt-4 space-y-3">

              {/* 1.（補助）TAWSSとOSIの関係の表示（テキスト） */}
              <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3 text-xs text-slate-300 flex items-start gap-2">
                <TrendingUp className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <div className="font-bold text-slate-200">① TAWSS と OSI の関係</div>
                  <div className="text-slate-300">{relationshipLine}</div>
                  {graphComment && !isPlaying && (
                    <div className="text-slate-400">補足: {graphComment}</div>
                  )}
                </div>
              </div>

              {/* 2. 判定comment */}
              <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="text-2xl">{stenosisIcon(stenosisResult?.cls?.category)}</div>
                  <div className="flex flex-col">
                    <div className="text-slate-400 text-[11px] font-bold">② 判定 comment</div>
                    <div className="text-slate-100 font-bold text-sm">
                      {stenosisResult?.cls?.category ? stenosisSummaryText : "解析後に表示されます"}
                    </div>
                    {stenosisResult?.cls?.category && (
                      <div className="text-[11px] text-slate-400">
                        {stenosisResult?.cls?.ruleUsed}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 3. パラメータ数値の説明ボタン（押すとポップアップ） */}
              <div className="flex items-center justify-between bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3">
                <div className="text-xs text-slate-400">
                  ③ 判定に使用したパラメータ（corr / lag / sim）の説明
                </div>
                <button
                  onClick={() => setShowParamExplain(true)}
                  disabled={!stenosisResult?.feat}
                  className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs disabled:opacity-30 disabled:hover:bg-slate-700 flex items-center gap-2"
                >
                  <Info className="w-4 h-4" />
                  説明を表示
                </button>
              </div>

              {/* 4. アラート値ピックアップ */}
              <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3">
                <div className="text-slate-200 font-bold text-xs mb-2">④ アラート値ピックアップ（TAWSS / OSI / RRT / PressureProxy）</div>
                <div className="grid grid-cols-1 gap-3">
                  {alertPickups.map((a, i) => (
                    <div
                      key={i}
                      className={`p-3 rounded border flex items-center gap-3 ${
                        a.type === 'danger'
                          ? 'bg-red-900/20 border-red-800'
                          : a.type === 'warning'
                            ? 'bg-yellow-900/20 border-yellow-800'
                            : 'bg-green-900/20 border-green-800'
                      }`}
                    >
                      <AlertCircle className={`w-5 h-5 ${a.type === 'danger' ? 'text-red-500' : a.type === 'warning' ? 'text-yellow-500' : 'text-green-500'}`} />
                      <div className="flex-1">
                        <div className="font-bold text-sm text-slate-200">{a.title}</div>
                        <div className="text-xs text-slate-400">{a.desc}</div>
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono">{a.frameLabel}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 5. 最も危険なframeをピックアップ（3枚）→ Checkで表示 */}
              <div className="bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-slate-200 font-bold text-xs">⑤ 最も危険なフレーム（上位3）</div>
                  <div className="text-[11px] text-slate-400">
                    解析中に自動キャプチャした危険度上位フレームを表示します（Checkで展開）。
                  </div>
                </div>
                <button
                  onClick={openDangerFramesModal}
                  disabled={!dangerFrames.length}
                  className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs disabled:opacity-30 disabled:hover:bg-slate-700 flex items-center gap-2"
                >
                  <Eye className="w-4 h-4" />
                  Check
                </button>
              </div>
            </div>

            {/* 既存の診断カード（残す：補助情報として） */}
            <div className="grid grid-cols-1 gap-3 mt-6">
              {diagnosticText.map((d, i) => (
                <div
                  key={i}
                  className={`p-3 rounded border flex items-center gap-3 ${
                    d.type === 'danger'
                      ? 'bg-red-900/20 border-red-800'
                      : d.type === 'warning'
                        ? 'bg-yellow-900/20 border-yellow-800'
                        : 'bg-green-900/20 border-green-800'
                  }`}
                >
                  <AlertCircle className={`w-5 h-5 ${d.type === 'danger' ? 'text-red-500' : d.type === 'warning' ? 'text-yellow-500' : 'text-green-500'}`} />
                  <div className="flex-1">
                    <div className="font-bold text-sm text-slate-200">{d.title}</div>
                    <div className="text-xs text-slate-400">{d.desc}</div>
                  </div>
                  {d.rawFrame && (
                    <button onClick={() => openFrameModal(d)} className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded text-white">
                      <Eye className="w-3 h-3 inline mr-1" />Check
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {is3DModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 animate-in fade-in">
          <div
            ref={modalContainerRef}
            className="w-full h-full max-w-6xl max-h-[90vh] bg-slate-900 rounded-xl border border-slate-700 flex flex-col relative overflow-hidden"
          >
            <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
              <button
                onClick={() => setInteractionMode('delete')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors border ${
                  interactionMode === 'delete'
                    ? 'bg-red-600/90 border-red-500 text-white shadow-lg shadow-red-900/20'
                    : 'bg-slate-800/80 border-slate-600 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <Eraser className="w-4 h-4" />
                <span className="text-sm font-medium">修正 (削除)</span>
              </button>

              <button
                onClick={() => setInteractionMode('move')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors border ${
                  interactionMode === 'move'
                    ? 'bg-emerald-600/90 border-emerald-500 text-white shadow-lg shadow-emerald-900/20'
                    : 'bg-slate-800/80 border-slate-600 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <Move className="w-4 h-4" />
                <span className="text-sm font-medium">移動 (パン)</span>
              </button>

              <button
                onClick={() => setInteractionMode('rotate')}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors border ${
                  interactionMode === 'rotate'
                    ? 'bg-blue-600/90 border-blue-500 text-white shadow-lg shadow-blue-900/20'
                    : 'bg-slate-800/80 border-slate-600 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <Move3d className="w-4 h-4" />
                <span className="text-sm font-medium">回転 (視点)</span>
              </button>

              {historyStack.length > 0 && (
                <button
                  onClick={handleUndo}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/80 border border-slate-600 text-slate-300 hover:bg-slate-700 transition-colors mt-2"
                >
                  <Undo className="w-4 h-4" />
                  <span className="text-sm">元に戻す</span>
                </button>
              )}
            </div>

            <button
              onClick={handleSave3DImage}
              className="absolute top-4 right-16 p-2 bg-slate-800/80 rounded-full hover:bg-slate-700 text-white z-10 border border-slate-600 flex items-center gap-2 px-4"
              title="3Dモデルを画像として保存"
            >
              <Camera className="w-5 h-5" />
              <span className="text-sm font-medium">保存</span>
            </button>

            <button
              onClick={() => setIs3DModalOpen(false)}
              className="absolute top-4 right-4 p-2 bg-slate-800/80 rounded-full hover:bg-slate-700 text-white z-10 border border-slate-600"
            >
              <X className="w-6 h-6" />
            </button>

            <div
              className={`flex-1 w-full h-full ${
                interactionMode === 'delete' ? 'cursor-crosshair' : interactionMode === 'move' ? 'cursor-move' : 'cursor-grab'
              }`}
              onMouseDown={handle3DMouseDown}
              onMouseMove={handle3DMouseMove}
              onMouseUp={handle3DMouseUp}
              onMouseLeave={handle3DMouseUp}
              onWheel={handleWheel}
            >
              <canvas
                ref={stackCanvasLargeRef}
                width={modalSize.w}
                height={modalSize.h}
                className="block"
              />
            </div>

            <div className="absolute bottom-6 right-6 flex flex-col gap-2 z-10 items-end">
              <div className="flex items-center gap-2 bg-slate-800/90 p-2 rounded-lg border border-slate-600 backdrop-blur-sm shadow-xl">
                <button onClick={() => setZoomLevel(z => Math.min(z * 1.2, 5))} className="p-1.5 hover:bg-slate-700 rounded text-slate-300"><ZoomIn className="w-4 h-4" /></button>
                <span className="text-xs text-slate-400 font-mono w-10 text-center">{Math.round(zoomLevel * 100)}%</span>
                <button onClick={() => setZoomLevel(z => Math.max(z / 1.2, 0.2))} className="p-1.5 hover:bg-slate-700 rounded text-slate-300"><ZoomOut className="w-4 h-4" /></button>
                <div className="w-px h-4 bg-slate-600 mx-1"></div>
                <button
                  onClick={() => { setZoomLevel(1); setRot3D({ x: 0.5, y: 0.5 }); setPan3D({ x: 0, y: 0 }); }}
                  className="p-1.5 hover:bg-slate-700 rounded text-slate-300"
                  title="Reset View"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center gap-3 bg-slate-800/90 px-4 py-2 rounded-lg border border-slate-600 backdrop-blur-sm shadow-xl">
                <span className="text-xs font-bold text-slate-300">Filter</span>
                <input
                  type="range" min="0" max="3" step="1"
                  value={noiseFilterLevel}
                  onChange={(e) => setNoiseFilterLevel(Number(e.target.value))}
                  className="w-20 h-1.5 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <span className="text-xs font-mono text-blue-300 w-8 text-center">{['Off', 'Low', 'Med', 'Hi'][noiseFilterLevel]}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 既存：単一フレームのモーダル */}
      {modalData && modalData.type !== 'dangerFrames' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-1 max-w-4xl w-full">
            <div className="flex justify-between items-center p-3 border-b border-slate-700 mb-2">
              <span className="font-bold">{modalData.title}</span>
              <button onClick={() => setModalData(null)}><X className="w-5 h-5" /></button>
            </div>
            <div className="aspect-video bg-black flex justify-center">
              <canvas ref={modalCanvasRef} className="h-full object-contain" />
            </div>
          </div>
        </div>
      )}

      {/* 新規：危険フレーム（上位3）のモーダル（Checkで開く） */}
      {modalData && modalData.type === 'dangerFrames' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 max-w-5xl w-full">
            <div className="flex justify-between items-center pb-3 border-b border-slate-700 mb-4">
              <span className="font-bold">{modalData.title}</span>
              <button onClick={() => setModalData(null)} className="p-2 hover:bg-slate-700 rounded"><X className="w-5 h-5" /></button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {modalData.frames.map((f, idx) => (
                <div key={idx} className="bg-slate-900 rounded-lg border border-slate-700 overflow-hidden">
                  <div className="px-3 py-2 text-xs text-slate-300 flex items-center justify-between border-b border-slate-700">
                    <span className="font-mono">F{f.frame}</span>
                    <span className="text-slate-400">{Number(f.timeSec).toFixed(2)}s</span>
                  </div>
                  <div className="aspect-video bg-black flex items-center justify-center">
                    <img src={f.img} alt={`frame-${f.frame}`} className="w-full h-full object-contain" />
                  </div>
                  <div className="px-3 py-2 text-[11px] text-slate-400 border-t border-slate-700">
                    score: {Number(f.score).toFixed(1)}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 text-[11px] text-slate-400">
              ※危険度スコアは「AvgWSS＋PressureProxy（面積）を係数で補正」した簡易指標です。運用に合わせて係数調整できます。
            </div>
          </div>
        </div>
      )}

      {/* 新規：パラメータ説明ポップアップ（3のボタン） */}
      {showParamExplain && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 max-w-2xl w-full">
            <div className="flex justify-between items-center pb-3 border-b border-slate-700 mb-4">
              <div className="font-bold flex items-center gap-2">
                <Info className="w-5 h-5 text-blue-400" />
                判定パラメータの説明
              </div>
              <button onClick={() => setShowParamExplain(false)} className="p-2 hover:bg-slate-700 rounded">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-sm text-slate-200">
              <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-3">
                <div className="text-xs text-slate-400 font-bold mb-1">使用パラメータ（今回の値）</div>
                <div className="text-xs text-slate-300 font-mono">
                  {stenosisResult?.feat
                    ? `corr=${stenosisResult.feat.corr.toFixed(2)} / lag=${stenosisResult.feat.lagSec.toFixed(2)}s / sim=${stenosisResult.feat.simPeaks}`
                    : "解析待機中"}
                </div>
                {stenosisResult?.cls?.mildSuspicionScore !== null && stenosisResult?.cls?.mildSuspicionScore !== undefined && (
                  <div className="text-xs text-slate-400 mt-1">
                    mild_score（補正用）: {Number(stenosisResult.cls.mildSuspicionScore).toFixed(2)}
                  </div>
                )}
              </div>

              <div className="space-y-2 text-xs text-slate-300 leading-relaxed">
                <div>
                  <span className="font-bold text-slate-100">corr（相関）</span>：
                  TAWSS と PressureProxy（面積）の「連動の強さ」。±1に近いほど連動が強く、流体力学的に同時変動が目立つ状態を示します。
                </div>
                <div>
                  <span className="font-bold text-slate-100">lag（遅れ）</span>：
                  どちらが先行・遅延しているかの指標（クロス相関で最大となる時間差）。
                  狭窄や流れの乱れがあると、波形のタイミングズレとして現れることがあります。
                </div>
                <div>
                  <span className="font-bold text-slate-100">sim（同時ピーク数）</span>：
                  WSSのピークが、PressureProxyのピークと同時（±1サンプル以内）に出現した回数。
                  同時ピークが多いほど「連動性が明確」な傾向とみなします。
                </div>
                <div className="text-slate-400 pt-2 border-t border-slate-700">
                  ※PressureProxy は現状「血流領域の面積（Area）」を代理指標として使用しています（運用に合わせて差し替え可能）。
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <button onClick={() => setShowParamExplain(false)} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-white text-sm">
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ShuntWSSAnalyzer;
