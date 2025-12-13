  // ShuntFlow Analytics - v1.0.0 Release Candidate
import React, { useState, useRef, useEffect, useCallback,useLayoutEffect } from 'react';
import { Upload, Play, Pause, RotateCcw, Activity, AlertCircle, FileVideo, Crosshair, Gauge, Download, Settings, Ruler, Scan, Layers, Eye, Zap, Move3d, MousePointer2, TrendingUp, Maximize2, X, Sliders, Eraser, Undo, Scissors, ZoomIn, ZoomOut, RefreshCw, Move, Camera } from 'lucide-react';
import { ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const ShuntWSSAnalyzer = () => {
  const [videoSrc, setVideoSrc] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  
  // --- 解析設定 ---
  const [config, setConfig] = useState({
    colorThreshold: 40,      // 血流検知閾値
    wallThreshold: 50,       // 血管壁検知閾値
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
  const [pan3D, setPan3D] = useState({ x: 0, y: 0 }); // 移動(パン)用オフセット
  const [zoomLevel, setZoomLevel] = useState(1.0); // ズームレベル
  const [isDragging3D, setIsDragging3D] = useState(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const [noiseFilterLevel, setNoiseFilterLevel] = useState(1);
  const [is3DModalOpen, setIs3DModalOpen] = useState(false);
  const modalContainerRef = useRef(null); 
  const [modalSize, setModalSize] = useState({ w: 800, h: 600 });
  
  // 3D修正モード用 (interactionMode: 'rotate' | 'move' | 'delete')
  const [interactionMode, setInteractionMode] = useState('rotate');
  const [selectionBox, setSelectionBox] = useState(null); // {sx, sy, cx, cy}
  const [historyStack, setHistoryStack] = useState([]); // Undo用

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

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const bullseyeRef = useRef(null);
  const stackCanvasRef = useRef(null);
  const stackCanvasLargeRef = useRef(null);
  const modalCanvasRef = useRef(null);
  const animationRef = useRef(null);
  const containerRef = useRef(null);
  
  const chartWrapRef = useRef(null);
  const [chartReady, setChartReady] = useState(false);
  
  useLayoutEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;
  
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setChartReady(width > 10 && height > 10);
    });
  
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  
  const accumulationRef = useRef({
    sectors: Array(36).fill(0),
    frameCount: 0,
    startTime: 0,
    centroid: { x: 0, y: 0 },
    stackBuffer: []
  });

  // --- 初期化 ---
  const resetAnalysis = () => {
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
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
    setPan3D({ x: 0, y: 0 }); // 移動リセット
    setInteractionMode('rotate'); 
    
    accumulationRef.current = {
      sectors: Array(config.sectorCount).fill(0).map(() => ({
        sumSignedWss: 0, sumAbsWss: 0, count: 0,
        maxWss: 0, maxFrame: 0, minWss: 0, minFrame: 0
      })),
      frameCount: 0,
      centroid: { x: 0, y: 0 },
      stackBuffer: []
    };
    
    // Canvasクリア
    [bullseyeRef, stackCanvasRef, stackCanvasLargeRef].forEach(ref => {
        if(ref.current) {
            const ctx = ref.current.getContext('2d');
            ctx.clearRect(0, 0, ref.current.width, ref.current.height);
        }
    });
    requestAnimationFrame(renderOverlay);
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideoSrc(url);
      setConfig(prev => ({ ...prev, roiFlow: null, roiVessel: null, scalePxPerCm: 0 }));
    }
  };

  const handleVideoLoaded = () => {
      resetAnalysis();
      if(videoRef.current && canvasRef.current) {
          requestAnimationFrame(renderOverlay);
      }
  };

  // --- 3D保存 (スクリーンショット) ---
  const handleSave3DImage = () => {
    const canvas = stackCanvasLargeRef.current;
    if (!canvas) return;
    
    const image = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = image;
    link.download = `3d_vessel_model_${new Date().toISOString().slice(0,19).replace(/[-:]/g,"")}.png`;
    link.click();
  };

  // --- 描画 (Overlay & Preview) ---
  const renderOverlay = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    if (video.videoWidth > 0 && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    if (!isPlaying) {
        ctx.drawImage(video, 0, 0, w, h);
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
        ctx.fillText(label, rx, ry - 5);
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
            ctx.fillText(`P${idx+1}`, px + 8, py);
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

  // --- マウス操作 (ROI/Calib) ---
  const handleMouseDown = (e) => {
    if (toolMode === 'none' || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;

    if (toolMode === 'calibration') {
        const newPoints = [...calibPoints, { x: nx, y: ny }];
        setCalibPoints(newPoints);
        if (newPoints.length === 2) {
            const dx = (newPoints[0].x - newPoints[1].x) * videoRef.current.videoWidth;
            const dy = (newPoints[0].y - newPoints[1].y) * videoRef.current.videoHeight;
            setConfig(p => ({ ...p, scalePxPerCm: Math.sqrt(dx*dx + dy*dy) }));
            setCalibPoints([]); setToolMode('none');
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

  // --- 3D 操作 & 修正 ---
  
  // モーダルサイズ同期
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
          setRot3D(prev => ({
              x: prev.x + deltaY * 0.01,
              y: prev.y + deltaX * 0.01
          }));
      } else if (interactionMode === 'move') {
          setPan3D(prev => ({
              x: prev.x + deltaX,
              y: prev.y + deltaY
          }));
      }

      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      
      requestAnimationFrame(() => {
          drawStack(accumulationRef.current.stackBuffer, stackCanvasRef.current, false);
          if(is3DModalOpen) drawStack(accumulationRef.current.stackBuffer, stackCanvasLargeRef.current, true);
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

  // 3D点群の削除処理
  const deleteSelectedPoints = () => {
      if (!selectionBox || !stackCanvasLargeRef.current) return;
      
      const { sx, sy, cx, cy } = selectionBox;
      const minX = Math.min(sx, cx), maxX = Math.max(sx, cx);
      const minY = Math.min(sy, cy), maxY = Math.max(sy, cy);
      
      const canvas = stackCanvasLargeRef.current;
      const w = canvas.width, h = canvas.height;
      const centerX = w/2 + pan3D.x; // パン考慮
      const centerY = h/2 + pan3D.y; // パン考慮
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

          const zBase = (idx - bufferLength/2) * 3; 
          
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

 // --- 解析ロジック (省略なし) ---
  const processFrame = useCallback(() => {
    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
  
      if (!video || !canvas) return;
      if (video.paused || video.ended) return;
  
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
  
      if (canvas.width !== video.videoWidth) {
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
      let frameTotalStress = 0, frameMaxStress = 0, frameStressPixels = 0;
  
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
              let stress = Math.min(255, maxVel * (maxVel / 255 * config.stressMultiplier));
              frameTotalStress += stress;
              if (stress > frameMaxStress) frameMaxStress = stress;
              frameStressPixels++;
  
              const cx = accumulationRef.current.centroid.x || w / 2;
              const cy = accumulationRef.current.centroid.y || h / 2;
              let angle = Math.atan2(y - cy, x - cx) * (180 / Math.PI);
              if (angle < 0) angle += 360;
  
              const sIdx = Math.floor(angle / (360 / config.sectorCount)) % config.sectorCount;
              const sec = accumulationRef.current.sectors[sIdx];
              if (!sec) continue; // ★ここで落とさない
  
              sec.sumAbsWss += stress;
              sec.sumSignedWss += stress * maxDir;
              sec.count++;
              if (stress > sec.maxWss) { sec.maxWss = stress; sec.maxFrame = accumulationRef.current.frameCount; }
              // minWss の初期値が 0 だと更新されにくいので、必要なら minWss を Infinity 初期化してください
              if (maxDir < 0 && stress > sec.minWss) { sec.minWss = stress; sec.minFrame = accumulationRef.current.frameCount; }
  
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
  
      if (flowCount > 0) accumulationRef.current.centroid = { x: flowSumX / flowCount, y: flowSumY / flowCount };
  
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = w; tempCanvas.height = h;
      tempCanvas.getContext('2d').putImageData(overlayData, 0, 0);
      ctx.globalAlpha = 1.0;
      ctx.drawImage(tempCanvas, 0, 0);
  
      const acc = accumulationRef.current;
      acc.frameCount++;
  
      // ★UI更新は重いので間引く（6フレームに1回）
      if (acc.frameCount % 6 === 0) {
        setCurrentFrameCount(acc.frameCount);
      }
  
      // stackも無限に増やさない（最大120フレーム）
      if (acc.frameCount % 2 === 0) {
        acc.stackBuffer.push({ frame: acc.frameCount, vesselPoints });
        if (acc.stackBuffer.length > 120) acc.stackBuffer.splice(0, acc.stackBuffer.length - 120);
  
        drawStack(acc.stackBuffer, stackCanvasRef.current, false);
        if (is3DModalOpen) drawStack(acc.stackBuffer, stackCanvasLargeRef.current, true);
      }
  
      let areaVal = flowCount;
      let unit = 'px²';
      if (config.scalePxPerCm > 0) {
        areaVal = flowCount / (config.scalePxPerCm ** 2);
        unit = 'cm²';
      }
  
      const avg = frameStressPixels > 0 ? frameTotalStress / frameStressPixels : 0;
  
      // ★時系列も間引き＆上限200点
      if (acc.frameCount % 6 === 0) {
        setTimeSeriesData(prev => {
          const next = [...prev, {
            frame: acc.frameCount,
            avgWss: Number(avg.toFixed(1)),
            area: Number(areaVal.toFixed(3)),
          }];
          return next.length > 200 ? next.slice(-200) : next;
        });
  
        setRealtimeMetrics({
          avg: Math.round(avg),
          max: Math.round(frameMaxStress),
          area: `${areaVal.toFixed(2)} ${unit}`,
          evaluation: avg > 80 ? 'HIGH' : avg > 40 ? 'WARN' : 'NORM'
        });
      }
  
      animationRef.current = requestAnimationFrame(processFrame);
  
    } catch (e) {
      console.error("processFrame crashed:", e);
      cancelAnimationFrame(animationRef.current);
      setIsPlaying(false);
      setAnalysisStatus?.("エラー");
    }
  }, [config, is3DModalOpen]);

  // --- 3D描画 ---
  const drawStack = useCallback((buffer, canvas, isLarge) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      
      ctx.fillStyle = '#0f172a'; 
      ctx.fillRect(0,0,w,h);
      
      if (buffer.length === 0) {
          ctx.fillStyle = '#475569'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText("No Vessel Shape Data", w/2, h/2);
          return;
      }

      const cx = w/2 + (isLarge ? pan3D.x : 0); 
      const cy = h/2 + (isLarge ? pan3D.y : 0);
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

      const hasNeighbor = (p, frameIdx, currentSliceIdx) => {
          if (noiseFilterLevel === 0) return true; 
          const range = noiseFilterLevel * 3;
          if (currentSliceIdx > 0) {
              const prevSlice = showFrames[currentSliceIdx - 1];
              for(let pp of prevSlice.vesselPoints) {
                  if (Math.abs(pp.x - p.x) < range && Math.abs(pp.y - p.y) < range) return true;
              }
          }
          if (currentSliceIdx < showFrames.length - 1) {
              const nextSlice = showFrames[currentSliceIdx + 1];
              for(let np of nextSlice.vesselPoints) {
                  if (Math.abs(np.x - p.x) < range && Math.abs(np.y - p.y) < range) return true;
              }
          }
          return false;
      };

      showFrames.forEach((slice, idx) => {
          const zBase = (idx - showFrames.length/2) * (isLarge ? 3 : 2); 
          const alphaBase = 0.2 + (idx / showFrames.length) * 0.8;
          
          ctx.strokeStyle = `rgba(200, 230, 255, ${alphaBase * 0.5})`;
          ctx.lineWidth = 0.5;
          ctx.fillStyle = `rgba(220, 240, 255, ${alphaBase})`;

          const projectedPoints = [];

          slice.vesselPoints.forEach(p => {
              if (!hasNeighbor(p, slice.frame, idx)) return;

              const r = rotate(p.x, p.y, zBase, rot3D.x, rot3D.y);
              const perspective = 400 / (400 - r.z); 
              const px = cx + r.x * scale * perspective;
              const py = cy + r.y * scale * perspective;
              
              projectedPoints.push({x: px, y: py, z: r.z});

              const size = isLarge ? 1.5 * perspective : 1.2;
              ctx.fillRect(px, py, size, size);
          });

          if (isLarge && idx > 0 && idx % 2 === 0) {
              ctx.beginPath();
              projectedPoints.forEach((p, pIdx) => {
                  if(pIdx > 0 && Math.abs(p.x - projectedPoints[pIdx-1].x) < 10 && Math.abs(p.y - projectedPoints[pIdx-1].y) < 10) {
                      ctx.moveTo(p.x, p.y);
                      ctx.lineTo(projectedPoints[pIdx-1].x, projectedPoints[pIdx-1].y);
                  }
              });
              ctx.stroke();
          }
      });
      
      // 選択ボックス描画
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

      ctx.strokeStyle = '#475569'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(w-30, h-30); ctx.lineTo(w-10, h-30); ctx.stroke(); ctx.fillText('X', w-10, h-35);
      ctx.beginPath(); ctx.moveTo(w-30, h-30); ctx.lineTo(w-30, h-10); ctx.stroke(); ctx.fillText('Y', w-35, h-10);

  }, [rot3D, pan3D, noiseFilterLevel, interactionMode, selectionBox, zoomLevel]);

  useEffect(() => { 
      drawStack(accumulationRef.current.stackBuffer, stackCanvasRef.current, false); 
      if(is3DModalOpen) drawStack(accumulationRef.current.stackBuffer, stackCanvasLargeRef.current, true);
  }, [drawStack, is3DModalOpen]);

  const togglePlay = () => {
      if(!videoRef.current) return;
      if(isPlaying) {
          videoRef.current.pause(); setIsPlaying(false); cancelAnimationFrame(animationRef.current);
      } else {
          if(analysisStatus === '完了') resetAnalysis();
          videoRef.current.play(); setIsPlaying(true); setAnalysisStatus('解析中');
          requestAnimationFrame(processFrame);
      }
  };
  
  const handleVideoEnded = () => {
      setIsPlaying(false); cancelAnimationFrame(animationRef.current);
      finalizeAnalysis();
  };

  const finalizeAnalysis = () => {
    setAnalysisStatus('完了');
    const acc = accumulationRef.current;
    const results = acc.sectors.map((s, i) => {
        if(s.count===0) return { angle:i*10, tawss:0, osi:0, rrt:0, maxWss:0, maxFrame:0 };
        const tawss = s.sumAbsWss / s.count;
        const osi = s.sumAbsWss > 0 ? 0.5 * (1 - Math.abs(s.sumSignedWss)/s.sumAbsWss) : 0;
        const den = (1-2*osi)*tawss;
        return {
            angle: i*10,
            tawss: parseFloat(tawss.toFixed(2)),
            osi: parseFloat(osi.toFixed(3)),
            rrt: parseFloat((den>0.01 ? 1/den : 100).toFixed(3)),
            maxWss: s.maxWss, maxFrame: s.maxFrame
        };
    });
    setSectorResults(results);
    drawBullseye(results);
    generateDiagnostics(results);
  };

  const generateDiagnostics = (results) => {
     const list = [];
     const highWss = results.filter(r => r.tawss > 80);
     let bComment = "特記すべき高WSS領域なし";
     if (highWss.length > 0) {
         const peak = highWss.reduce((p, c) => p.tawss > c.tawss ? p : c);
         bComment = `${peak.angle}°付近が高WSSです`;
         let dir = "";
         if(peak.angle >= 315 || peak.angle < 45) dir = "(右側)";
         else if(peak.angle >= 45 && peak.angle < 135) dir = "(下側)";
         else if(peak.angle >= 135 && peak.angle < 225) dir = "(左側)";
         else dir = "(上側)";
         bComment += ` ${dir}`;
     }
     setBullseyeComment(bComment);

     const avgAll = results.reduce((sum, r) => sum + r.tawss, 0) / results.length;
     let gComment = avgAll > 60 ? "全体的にWSSが高い傾向。" : "平均的なWSSレベル。";
     
     if(timeSeriesData.length > 0) {
         const areas = timeSeriesData.map(d => d.area);
         const minA = Math.min(...areas);
         const maxA = Math.max(...areas);
         const distensibility = minA > 0 ? (maxA - minA) / minA : 0;
         if(distensibility < 0.1) gComment += " 血管壁の伸展性が低下している可能性があります(Low Compliance)。";
         else gComment += " 良好な拍動変動が見られます。";
     }
     setGraphComment(gComment);

     const high = results.filter(r => r.tawss > 80 && r.osi < 0.2);
     if(high.length) {
         const max = high.reduce((p,c)=>p.tawss>c.tawss?p:c);
         list.push({ type: 'warning', title: 'High Shear', desc: `${max.angle}°付近で高ストレス`, frameLabel: `F${max.maxFrame}`, rawFrame: max.maxFrame });
     }
     const low = results.filter(r => r.rrt > 0.5);
     if(low.length) {
         const max = low.reduce((p,c)=>p.rrt>c.rrt?p:c);
         list.push({ type: 'danger', title: 'Stagnation', desc: `${max.angle}°付近で滞留リスク`, frameLabel: '-', rawFrame: null });
     }
     setDiagnosticText(list.length ? list : [{type:'success', title:'Normal', desc:'異常なし'}]);
  };

  const drawBullseye = (results) => {
      const cvs = bullseyeRef.current; if(!cvs) return;
      const ctx = cvs.getContext('2d'); const w=cvs.width, h=cvs.height, cx=w/2, cy=h/2, r=w/2-20;
      ctx.clearRect(0,0,w,h);
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle='#1e293b'; ctx.fill();
      ctx.strokeStyle = '#334155'; ctx.lineWidth=1;
      
      for(let i=0; i<12; i++) {
          const rad = (i*30 - 90) * Math.PI/180;
          ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx + Math.cos(rad)*r, cy + Math.sin(rad)*r); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(cx,cy,r*0.66,0,Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx,cy,r*0.33,0,Math.PI*2); ctx.stroke();

      results.forEach(s => {
          const sa = (s.angle-90)*Math.PI/180, ea = (s.angle+10-90)*Math.PI/180;
          const val = Math.min(s.tawss*2, 255);
          ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,r,sa,ea); ctx.closePath();
          ctx.fillStyle = val<128 ? `rgb(${val*2},255,0)` : `rgb(255,${255-(val-128)*2},0)`;
          ctx.fill();
          if(s.osi > 0.15) { ctx.fillStyle = `rgba(0,0,0,${s.osi*1.5})`; ctx.fill(); }
      });
      ctx.beginPath(); ctx.arc(cx,cy,r*0.2,0,Math.PI*2); ctx.fillStyle='#0f172a'; ctx.fill(); ctx.stroke();

      ctx.fillStyle = '#94a3b8'; ctx.font = '10px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      [[0,'0°(R)'], [90,'90°(B)'], [180,'180°(L)'], [270,'270°(T)']].forEach(([deg, txt]) => {
          const rad = (deg - 90) * Math.PI/180;
          ctx.fillText(txt, cx + Math.cos(rad)*(r+12), cy + Math.sin(rad)*(r+12));
      });
  };

  const handleDownloadCSV = () => {
      if(!sectorResults.length) return;
      const head = ['Angle', 'TAWSS', 'OSI', 'RRT', 'MaxWSS', 'MaxFrame'];
      const rows = sectorResults.map(r => Object.values(r).join(','));
      const blob = new Blob([[head.join(','), ...rows].join('\n')], {type:'text/csv'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'shunt_data.csv'; a.click();
  };

  const openFrameModal = (diag) => {
      if(diag.rawFrame && videoRef.current) {
          setModalData(diag);
          const dur = videoRef.current.duration;
          const total = accumulationRef.current.frameCount;
          if(total > 0) videoRef.current.currentTime = (diag.rawFrame/total) * dur;
      }
  };
  useEffect(() => {
      if(modalData && modalCanvasRef.current && videoRef.current) {
          const v = videoRef.current; const c = modalCanvasRef.current;
          c.width = v.videoWidth; c.height = v.videoHeight;
          const d = () => c.getContext('2d').drawImage(v,0,0,c.width,c.height);
          if(v.seeking) v.addEventListener('seeked', d, {once:true}); else d();
      }
  }, [modalData]);

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
               <button onClick={() => setToolMode(toolMode==='calibration'?'none':'calibration')} className={`p-2 rounded hover:bg-slate-700 relative ${toolMode==='calibration'?'bg-blue-600 text-white':'text-slate-400'}`} title="キャリブレーション">
                   <Ruler className="w-5 h-5" /> {config.scalePxPerCm>0 && <span className="absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full"></span>}
               </button>
               <button onClick={() => setToolMode(toolMode==='roi-flow'?'none':'roi-flow')} className={`p-2 rounded hover:bg-slate-700 relative ${toolMode==='roi-flow'?'bg-red-600 text-white':'text-slate-400'}`} title="解析ROI (血流)">
                   <Zap className="w-5 h-5" /> {config.roiFlow && <span className="absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full"></span>}
               </button>
               <button onClick={() => setToolMode(toolMode==='roi-vessel'?'none':'roi-vessel')} className={`p-2 rounded hover:bg-slate-700 relative ${toolMode==='roi-vessel'?'bg-emerald-600 text-white':'text-slate-400'}`} title="形状ROI (血管壁抽出)">
                   <Scan className="w-5 h-5" /> {config.roiVessel && <span className="absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full"></span>}
               </button>
               <button onClick={() => setShowSettings(!showSettings)} className={`p-2 rounded hover:bg-slate-700 ${showSettings?'bg-slate-600 text-white':'text-slate-400'}`} title="設定">
                   <Settings className="w-5 h-5" />
               </button>
           </div>
           <button onClick={handleDownloadCSV} disabled={!sectorResults.length} className="p-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white disabled:opacity-30 border border-slate-700"><Download className="w-5 h-5" /></button>
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
                  <input type="range" min="10" max="100" value={config.colorThreshold} onChange={(e)=>setConfig({...config, colorThreshold:Number(e.target.value)})} className="w-full accent-blue-500" />
              </div>
              <div>
                  <label className="text-xs text-slate-400 block mb-2">Wall Threshold (壁輝度): {config.wallThreshold}</label>
                  <input type="range" min="10" max="200" value={config.wallThreshold} onChange={(e)=>setConfig({...config, wallThreshold:Number(e.target.value)})} className="w-full accent-emerald-500" />
              </div>
              <div>
                  <label className="text-xs text-slate-400 block mb-2">Stress Multiplier (WSS強調): {config.stressMultiplier}</label>
                  <input type="range" min="0.5" max="5.0" step="0.1" value={config.stressMultiplier} onChange={(e)=>setConfig({...config, stressMultiplier:Number(e.target.value)})} className="w-full accent-orange-500" />
              </div>
          </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 space-y-4">
          <div 
            ref={containerRef}
            className={`bg-black rounded-xl overflow-hidden shadow-2xl border border-slate-700 relative aspect-video flex items-center justify-center group cursor-${toolMode==='none'?'default':'crosshair'}`}
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
                <video ref={videoRef} src={videoSrc} className="hidden" muted playsInline onEnded={handleVideoEnded} onLoadedData={handleVideoLoaded} />
                <canvas ref={canvasRef} className="w-full h-full object-contain pointer-events-none" />
                {toolMode === 'calibration' && <div className="absolute top-4 bg-blue-600/90 text-white px-3 py-1 rounded-full text-xs shadow-lg pointer-events-none">1cmの両端をクリック</div>}
                {toolMode === 'roi-flow' && <div className="absolute top-4 bg-red-600/90 text-white px-3 py-1 rounded-full text-xs shadow-lg pointer-events-none">血流解析範囲をドラッグ</div>}
                {toolMode === 'roi-vessel' && <div className="absolute top-4 bg-emerald-600/90 text-white px-3 py-1 rounded-full text-xs shadow-lg pointer-events-none">血管形状範囲をドラッグ (3D用)</div>}
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
              className={`flex-1 py-3 rounded-lg flex items-center justify-center gap-2 transition-all font-bold ${!videoSrc?'bg-slate-700 text-slate-500':isPlaying?'bg-red-500 hover:bg-red-600 text-white':analysisStatus==='完了'?'bg-green-600 hover:bg-green-500 text-white':'bg-blue-600 hover:bg-blue-500 text-white'}`}
            >
              {isPlaying ? <><Pause className="w-5 h-5" /> 停止</> : analysisStatus==='完了' ? <><RotateCcw className="w-5 h-5" /> 再解析</> : <><Play className="w-5 h-5" /> 解析開始</>}
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
                     <span className="flex items-center gap-2"><Move3d className="w-3 h-3"/> 3D Vessel</span>
                     <div className="flex items-center gap-2">
                         <button 
                            onClick={()=>setIs3DModalOpen(true)}
                            className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white"
                            title="拡大表示"
                         >
                             <Maximize2 className="w-3 h-3" />
                         </button>
                         <span className="text-[9px] text-slate-500 flex items-center gap-1"><MousePointer2 className="w-3 h-3"/> Drag</span>
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
                       onChange={(e)=>setNoiseFilterLevel(Number(e.target.value))}
                       className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                     />
                     <span className="text-[9px] text-slate-400">{['Off','Low','Med','High'][noiseFilterLevel]}</span>
                 </div>
              </div>
          </div>
        </div>

        <div className="lg:col-span-7 space-y-6">
          
          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 h-[400px] flex flex-col">
             <div className="flex justify-between items-center mb-4">
                 <h3 className="text-slate-400 text-sm font-medium flex items-center gap-2">
                     <Activity className="w-4 h-4"/> Analytic Graphs
                 </h3>
                 <div className="flex bg-slate-900 rounded-lg p-1 gap-1">
                    <button onClick={()=>setGraphMode('tawss_osi')} className={`px-3 py-1 text-xs rounded transition-colors ${graphMode==='tawss_osi'?'bg-slate-700 text-white font-bold':'text-slate-500 hover:text-slate-300'}`}>TAWSS & OSI</button>
                    <button onClick={()=>setGraphMode('wss_pressure')} className={`px-3 py-1 text-xs rounded transition-colors ${graphMode==='wss_pressure'?'bg-slate-700 text-white font-bold':'text-slate-500 hover:text-slate-300'}`}>WSS & Area</button>
                    <button onClick={()=>setGraphMode('rrt')} className={`px-3 py-1 text-xs rounded transition-colors ${graphMode==='rrt'?'bg-slate-700 text-white font-bold':'text-slate-500 hover:text-slate-300'}`}>RRT</button>
                 </div>
             </div>
             
             <div className="flex-1 min-h-0 min-w-0 relative">
              <div ref={chartWrapRef} className="w-full min-w-0" style={{ height: 280 }}>
                {chartReady ? (
                  <ResponsiveContainer
                    key={graphMode}
                    width="100%"
                    height="100%"
                    minWidth={0}
                    minHeight={260}
                    debounce={50}
                  >
                    {graphMode === 'wss_pressure' ? (
                      <ComposedChart data={timeSeriesData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="frame" stroke="#64748b" tick={{ fontSize: 10 }} label={{ value: 'Frame', position: 'insideBottom', offset: -5, fontSize: 10 }} />
                        <YAxis yAxisId="left" stroke="#3b82f6" label={{ value: 'Avg WSS', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#3b82f6' }} tick={{ fontSize: 10 }} />
                        <YAxis yAxisId="right" orientation="right" stroke="#10b981" label={{ value: `Area (${config.scalePxPerCm > 0 ? 'cm²' : 'px²'})`, angle: 90, position: 'insideRight', fontSize: 10, fill: '#10b981' }} tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                        <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155' }} />
                        <Legend verticalAlign="top" height={36} />
                        <Line yAxisId="left" type="monotone" dataKey="avgWss" stroke="#3b82f6" strokeWidth={2} name="Avg WSS" dot={false} />
                        <Area yAxisId="right" type="monotone" dataKey="area" stroke="#10b981" fill="rgba(16,185,129,0.2)" name="Vessel Area (Pressure Proxy)" />
                      </ComposedChart>
                    ) : graphMode === 'rrt' ? (
                      <ComposedChart data={sectorResults}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="angle" stroke="#64748b" tick={{ fontSize: 10 }} label={{ value: 'Angle', position: 'insideBottom', offset: -5, fontSize: 10 }} />
                        <YAxis stroke="#ef4444" label={{ value: 'RRT', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#ef4444' }} tick={{ fontSize: 10 }} />
                        <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155' }} />
                        <Legend verticalAlign="top" height={36} />
                        <Area type="monotone" dataKey="rrt" stroke="#ef4444" fill="rgba(239,68,68,0.2)" name="Relative Residence Time" />
                      </ComposedChart>
                    ) : (
                      <ComposedChart data={sectorResults}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="angle" stroke="#64748b" tick={{ fontSize: 10 }} label={{ value: 'Angle', position: 'insideBottom', offset: -5, fontSize: 10 }} />
                        <YAxis yAxisId="left" stroke="#3b82f6" label={{ value: 'TAWSS', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#3b82f6' }} tick={{ fontSize: 10 }} />
                        <YAxis yAxisId="right" orientation="right" stroke="#f59e0b" label={{ value: 'OSI', angle: 90, position: 'insideRight', fontSize: 10, fill: '#f59e0b' }} tick={{ fontSize: 10 }} domain={[0, 0.5]} />
                        <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155' }} />
                        <Legend verticalAlign="top" height={36} />
                        <Area yAxisId="left" type="monotone" dataKey="tawss" stroke="#3b82f6" fill="rgba(59,130,246,0.2)" name="TAWSS" />
                        <Line yAxisId="right" type="monotone" dataKey="osi" stroke="#f59e0b" strokeWidth={2} dot={false} name="OSI" />
                      </ComposedChart>
                    )}
                  </ResponsiveContainer>
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-500 text-xs">
                    Chart preparing...
                  </div>
                )}
              </div>
            
              {graphComment && (
                <div className="absolute bottom-2 left-10 right-10 bg-black/60 text-slate-300 text-xs px-3 py-2 rounded flex items-start gap-2 backdrop-blur-sm border border-slate-700/50">
                  <TrendingUp className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                  <span>{graphComment}</span>
                </div>
              )}
            </div>


          <div className="grid grid-cols-1 gap-3">
             {diagnosticText.map((d,i) => (
                 <div key={i} className={`p-3 rounded border flex items-center gap-3 ${d.type==='danger'?'bg-red-900/20 border-red-800':d.type==='warning'?'bg-yellow-900/20 border-yellow-800':'bg-green-900/20 border-green-800'}`}>
                     <AlertCircle className={`w-5 h-5 ${d.type==='danger'?'text-red-500':d.type==='warning'?'text-yellow-500':'text-green-500'}`} />
                     <div className="flex-1">
                         <div className="font-bold text-sm text-slate-200">{d.title}</div>
                         <div className="text-xs text-slate-400">{d.desc}</div>
                     </div>
                     {d.rawFrame && <button onClick={()=>openFrameModal(d)} className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded text-white"><Eye className="w-3 h-3 inline mr-1"/>Check</button>}
                 </div>
             ))}
          </div>
        </div>
      </div>
      
      {/* 3D拡大モーダル */}
      {is3DModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 animate-in fade-in">
           <div 
             ref={modalContainerRef}
             className="w-full h-full max-w-6xl max-h-[90vh] bg-slate-900 rounded-xl border border-slate-700 flex flex-col relative overflow-hidden"
           >
               {/* ツールバー (左上: 縦並び) */}
               <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
                   {/* 修正 (削除) モード */}
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
                   
                   {/* 移動モード (追加) */}
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

                   {/* 回転モード */}
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

               {/* 保存ボタン (右上: 閉じるボタンの左) */}
               <button 
                 onClick={handleSave3DImage}
                 className="absolute top-4 right-16 p-2 bg-slate-800/80 rounded-full hover:bg-slate-700 text-white z-10 border border-slate-600 flex items-center gap-2 px-4"
                 title="3Dモデルを画像として保存"
               >
                   <Camera className="w-5 h-5" />
                   <span className="text-sm font-medium">保存</span>
               </button>

               {/* 閉じるボタン (右上) */}
               <button 
                 onClick={()=>setIs3DModalOpen(false)}
                 className="absolute top-4 right-4 p-2 bg-slate-800/80 rounded-full hover:bg-slate-700 text-white z-10 border border-slate-600"
               >
                   <X className="w-6 h-6" />
               </button>
               
               {/* キャンバス */}
               <div 
                  className={`flex-1 w-full h-full ${interactionMode === 'delete' ? 'cursor-crosshair' : interactionMode === 'move' ? 'cursor-move' : 'cursor-grab'}`}
                  onMouseDown={handle3DMouseDown}
                  onMouseMove={handle3DMouseMove}
                  onMouseUp={handle3DMouseUp}
                  onMouseLeave={handle3DMouseUp}
                  onWheel={handleWheel} // ズーム
               >
                   {/* サイズを動的に合わせる */}
                   <canvas 
                     ref={stackCanvasLargeRef} 
                     width={modalSize.w} 
                     height={modalSize.h} 
                     className="block"
                   />
               </div>
               
               {/* コントロールパネル (右下コンパクト) */}
               <div className="absolute bottom-6 right-6 flex flex-col gap-2 z-10 items-end">
                   {/* ズーム & リセット */}
                   <div className="flex items-center gap-2 bg-slate-800/90 p-2 rounded-lg border border-slate-600 backdrop-blur-sm shadow-xl">
                       <button onClick={()=>setZoomLevel(z => Math.min(z*1.2, 5))} className="p-1.5 hover:bg-slate-700 rounded text-slate-300"><ZoomIn className="w-4 h-4"/></button>
                       <span className="text-xs text-slate-400 font-mono w-10 text-center">{Math.round(zoomLevel*100)}%</span>
                       <button onClick={()=>setZoomLevel(z => Math.max(z/1.2, 0.2))} className="p-1.5 hover:bg-slate-700 rounded text-slate-300"><ZoomOut className="w-4 h-4"/></button>
                       <div className="w-px h-4 bg-slate-600 mx-1"></div>
                       <button onClick={()=>{setZoomLevel(1); setRot3D({x:0.5, y:0.5}); setPan3D({x:0, y:0});}} className="p-1.5 hover:bg-slate-700 rounded text-slate-300" title="Reset View"><RefreshCw className="w-4 h-4"/></button>
                   </div>

                   {/* Auto Filter */}
                   <div className="flex items-center gap-3 bg-slate-800/90 px-4 py-2 rounded-lg border border-slate-600 backdrop-blur-sm shadow-xl">
                       <span className="text-xs font-bold text-slate-300">Filter</span>
                       <input 
                         type="range" min="0" max="3" step="1" 
                         value={noiseFilterLevel} 
                         onChange={(e)=>setNoiseFilterLevel(Number(e.target.value))}
                         className="w-20 h-1.5 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
                       />
                       <span className="text-xs font-mono text-blue-300 w-8 text-center">{['Off','Low','Med','Hi'][noiseFilterLevel]}</span>
                   </div>
               </div>
           </div>
        </div>
      )}

      {/* Frame check modal */}
      {modalData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
           <div className="bg-slate-800 rounded-xl border border-slate-700 p-1 max-w-4xl w-full">
              <div className="flex justify-between items-center p-3 border-b border-slate-700 mb-2">
                  <span className="font-bold">{modalData.title}</span>
                  <button onClick={()=>setModalData(null)}><X className="w-5 h-5"/></button>
              </div>
              <div className="aspect-video bg-black flex justify-center"><canvas ref={modalCanvasRef} className="h-full object-contain" /></div>
           </div>
        </div>
      )}
    </div>
  );
};

export default ShuntWSSAnalyzer;
