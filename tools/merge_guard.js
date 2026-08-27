// 건물 군집 병합 가드 — 2026-08-26 정후(QA) 실적발 사고(82.4m 떨어진 두 상업동을 하나로 묶어 아파트 504㎡ 포함) 재발방지용.
// 나머지 9곳(02~11) 핫스팟을 convexHull로 묶기 "전에" 반드시 이 게이트를 통과시킬 것.
// 근거 임계값 출처: .claude/agent-memory/qa-auditor/checklist_map_hotspot_coord_audit.md
//   - 구성 건물 간 최소 간격 20~30m 넘으면 자동 분리
//   - 껍질면적 ÷ 구성 건물 footprint 합이 2배 넘으면 자동 의심(REVIEW)
// 범위 한정: 이 파일은 index.html의 렌더링과 결합되어 있지 않은 "향후 작업용 오프라인 도구"임.
// 기존 12곳 HOTSPOT_DATA는 이미 병합된 shape만 남아있고 원본 건물별 footprint가 보존돼있지 않아
// 이 가드를 소급 적용할 수 없음 — 02~11번을 새로 만들 때부터 여기 통과시킬 것.

var GAP_THRESHOLD_M = 30;   // 이 거리(m) 넘게 떨어진 두 건물은 절대 같은 군집으로 묶지 않음
var AREA_RATIO_WARN = 2.0;  // 껍질면적/건물합이 이 배수 넘으면 "빈 공간을 삼켰다" 의심 표시

function toRad(deg) { return deg * Math.PI / 180; }

// lat/lng을 기준위도 주변의 평면 좌표(미터)로 근사 투영. 건물 군집 규모(<1km)에서만 정확.
function toXY(p, refLatRad) {
  return [p[1] * 111320 * Math.cos(refLatRad), p[0] * 110540];
}

function avgLatRad(points) {
  var sum = 0;
  for (var i = 0; i < points.length; i++) sum += points[i][0];
  return toRad(sum / points.length);
}

function pointSegDistM(p, a, b) {
  var px = p[0], py = p[1], ax = a[0], ay = a[1], bx = b[0], by = b[1];
  var dx = bx - ax, dy = by - ay;
  var len2 = dx * dx + dy * dy;
  var t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  var cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

// 두 건물 폴리곤 사이 최소 거리(m) — 한쪽 꼭짓점 → 반대쪽 모든 "변"까지의 최단거리(점-변), 양방향.
// 점-점 거리만 쓰면 벽면끼리 가까운데 꼭짓점만 멀리 떨어진 경우를 "멀다"고 오판함(정후 검증 3항목에서 오판 안 함을 실측 확인).
function minGapMetersBetweenPolygons(polyA, polyB) {
  var refLatRad = avgLatRad(polyA.concat(polyB));
  var A = polyA.map(function(p) { return toXY(p, refLatRad); });
  var B = polyB.map(function(p) { return toXY(p, refLatRad); });
  var min = Infinity;
  function scan(pts, ring) {
    for (var i = 0; i < pts.length; i++) {
      for (var j = 0; j < ring.length; j++) {
        var a = ring[j], b = ring[(j + 1) % ring.length];
        var d = pointSegDistM(pts[i], a, b);
        if (d < min) min = d;
      }
    }
  }
  scan(A, B);
  scan(B, A);
  return min;
}

// shoelace 면적(㎡). points는 [lat,lng] 배열(polygon ring, 닫힘 여부 무관).
function ringAreaM2(points) {
  if (points.length < 3) return 0;
  var refLatRad = avgLatRad(points);
  var proj = points.map(function(p) { return toXY(p, refLatRad); });
  var sum = 0;
  for (var i = 0; i < proj.length; i++) {
    var a = proj[i], b = proj[(i + 1) % proj.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

// index.html의 convexHull과 동일 알고리즘(Andrew's monotone chain) — 독립 실행용 포크.
// 정후가 랜덤 폴리곤 3000건 대조로 index.html 원본과 완전 일치 확인함(2026-08-27).
function convexHull(points) {
  var pts = points.slice().sort(function(a, b) { return a[0] - b[0] || a[1] - b[1]; });
  if (pts.length <= 3) return pts;
  function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
  var lower = [];
  for (var i = 0; i < pts.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
    lower.push(pts[i]);
  }
  var upper = [];
  for (var j = pts.length - 1; j >= 0; j--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[j]) <= 0) upper.pop();
    upper.push(pts[j]);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function validateFootprint(b, i) {
  if (!b.footprint || b.footprint.length < 3) {
    throw new Error('건물 footprint은 최소 3개 꼭짓점 필요(입력 index ' + i + ', id=' + (b.id || '?') + ')');
  }
}

// buildings: [{ id, name, footprint: [[lat,lng],...], useCode? }, ...]
// 완전연결(complete-linkage) 병합 — "새로 합칠 군집 안의 모든 쌍이 임계값 이내"일 때만 병합.
// 단순 최근접(single-linkage/union-find)은 A-B 25m·B-C 25m처럼 사슬로 이어지면 A-C가 110m처럼
// 임계값을 훨씬 넘어도 한 군집으로 묶여버리는 결함이 있음(정후 Critical 실적발, 2026-08-27) — 이를 원천 차단.
function clusterBuildings(buildings, opts) {
  opts = opts || {};
  var gapThreshold = (opts.gapThresholdM != null) ? opts.gapThresholdM : GAP_THRESHOLD_M;
  var areaRatioWarn = (opts.areaRatioWarn != null) ? opts.areaRatioWarn : AREA_RATIO_WARN;
  var n = buildings.length;

  buildings.forEach(validateFootprint);

  var gapMatrix = [];
  for (var i = 0; i < n; i++) {
    gapMatrix.push([]);
    for (var j = 0; j < n; j++) {
      gapMatrix[i].push(i === j ? 0 : minGapMetersBetweenPolygons(buildings[i].footprint, buildings[j].footprint));
    }
  }

  var clusters = [];
  for (var k = 0; k < n; k++) clusters.push([k]);

  while (true) {
    var bestA = -1, bestB = -1, bestVal = Infinity;
    for (var a = 0; a < clusters.length; a++) {
      for (var b = a + 1; b < clusters.length; b++) {
        var maxGap = 0;
        for (var x = 0; x < clusters[a].length; x++) {
          for (var y = 0; y < clusters[b].length; y++) {
            var g = gapMatrix[clusters[a][x]][clusters[b][y]];
            if (g > maxGap) maxGap = g;
          }
        }
        if (maxGap <= gapThreshold && maxGap < bestVal) { bestVal = maxGap; bestA = a; bestB = b; }
      }
    }
    if (bestA === -1) break;
    clusters[bestA] = clusters[bestA].concat(clusters[bestB]);
    clusters.splice(bestB, 1);
  }

  var residentialCodes = { "02000": true }; // 브이월드 주용도코드: 공동주택

  var result = clusters.map(function(memberIdx) {
    var members = memberIdx.map(function(i) { return buildings[i]; });
    var allPts = [];
    var footprintAreaSum = 0;
    var useCodes = {};
    var hasUnknownUse = false;
    members.forEach(function(m) {
      footprintAreaSum += ringAreaM2(m.footprint);
      m.footprint.forEach(function(p) { allPts.push(p); });
      if (m.useCode) useCodes[m.useCode] = true; else hasUnknownUse = true;
    });
    var hull = convexHull(allPts);
    var hullArea = ringAreaM2(hull);
    var areaRatio = footprintAreaSum > 0 ? hullArea / footprintAreaSum : Infinity;

    var maxInternalGap = 0;
    for (var x2 = 0; x2 < memberIdx.length; x2++) {
      for (var y2 = x2 + 1; y2 < memberIdx.length; y2++) {
        var g2 = gapMatrix[memberIdx[x2]][memberIdx[y2]];
        if (g2 > maxInternalGap) maxInternalGap = g2;
      }
    }

    var useCodeList = Object.keys(useCodes);
    var hasResidential = useCodeList.some(function(c) { return residentialCodes[c]; });

    return {
      ids: members.map(function(m) { return m.id; }),
      names: members.map(function(m) { return m.name; }),
      hull: hull,
      hullAreaM2: Math.round(hullArea),
      footprintAreaSumM2: Math.round(footprintAreaSum),
      areaRatio: Math.round(areaRatio * 100) / 100,
      maxInternalGapM: Math.round(maxInternalGap * 10) / 10,
      areaFlag: areaRatio > areaRatioWarn,
      gapFlag: maxInternalGap > gapThreshold, // 정상이면 항상 false(완전연결이 구조적으로 보장) — true면 알고리즘 불변식이 깨진 것이니 최우선 의심
      useCodes: useCodeList,
      useFlag: hasResidential,        // 공동주택 코드가 하나라도 섞이면 무조건 경고(혼재 여부와 무관 — 순수 아파트 군집도 잡아야 함)
      unknownUseFlag: hasUnknownUse   // useCode 미기입 = "확인 안 됨". "문제 없음"과 절대 같은 값으로 나오면 안 됨
    };
  });

  return { clusters: result, splitCount: result.length };
}

function auditReport(buildings, opts) {
  var result = clusterBuildings(buildings, opts);
  var lines = [];
  var gapThreshold = (opts && opts.gapThresholdM != null) ? opts.gapThresholdM : GAP_THRESHOLD_M;
  lines.push(buildings.length + '개 건물 입력 -> ' + result.splitCount + '개 군집으로 분리(간격 임계값 ' + gapThreshold + 'm 기준, 완전연결)');
  result.clusters.forEach(function(c, i) {
    lines.push('  군집 ' + (i + 1) + ': ' + c.names.join(', '));
    lines.push('    내부 최대간격 ' + c.maxInternalGapM + 'm' + (c.gapFlag ? ' <- REVIEW(불변식 위반 의심)' : '') +
      ' / 면적비(껍질÷건물합) ' + c.areaRatio + (c.areaFlag ? ' <- REVIEW(빈공간 의심)' : ''));
    if (c.useFlag) lines.push('    용도코드 경고: ' + c.useCodes.join(',') + ' <- REVIEW(공동주택 포함 의심)');
    if (c.unknownUseFlag) lines.push('    용도코드 미확인 건물 포함 <- 브이월드/OSM 재조회 필요(REVIEW와 별개로 반드시 확인)');
  });
  return lines.join('\n');
}

module.exports = {
  GAP_THRESHOLD_M: GAP_THRESHOLD_M,
  AREA_RATIO_WARN: AREA_RATIO_WARN,
  minGapMetersBetweenPolygons: minGapMetersBetweenPolygons,
  ringAreaM2: ringAreaM2,
  convexHull: convexHull,
  clusterBuildings: clusterBuildings,
  auditReport: auditReport
};

if (require.main === module) {
  // 자체 테스트 — 실제 사고 패턴을 합성 좌표로 재현해 가드가 실제로 분리/경고하는지 검증
  var assert = require('assert');

  // 케이스 1: 실적발 사고 재현 — 두 상업동이 실측 82.4m 이격(중심간이 아니라 함수가 재는 변-변 거리 기준) -> 반드시 분리돼야 함
  var buildingA = { id: 'A', name: '상업동A', footprint: [[37.20000, 127.20000], [37.20000, 127.20010], [37.20010, 127.20010], [37.20010, 127.20000]] };
  var buildingB = { id: 'B', name: '상업동B(변-변 82.4m 이격)', footprint: [[37.2008453, 127.20000], [37.2008453, 127.20010], [37.2009453, 127.20010], [37.2009453, 127.20000]] };
  var r1 = clusterBuildings([buildingA, buildingB]);
  assert.strictEqual(r1.splitCount, 2, '케이스1 실패: 82.4m 이격 건물이 분리되지 않음');
  r1.clusters.forEach(function(c) { assert.strictEqual(c.ids.length, 1, '케이스1 실패: 분리된 군집인데 건물이 2개 이상 묶임'); });

  // 케이스 2: 인접 건물 3개(변간 간격 5m 내외) -> 하나로 병합, 면적비는 2배 미만이어야 함
  var c1 = { id: 'C1', name: '건물1', footprint: [[37.21000, 127.21000], [37.21000, 127.21010], [37.21010, 127.21010], [37.21010, 127.21000]] };
  var c2 = { id: 'C2', name: '건물2', footprint: [[37.21000, 127.21012], [37.21000, 127.21022], [37.21010, 127.21022], [37.21010, 127.21012]] };
  var c3 = { id: 'C3', name: '건물3', footprint: [[37.21012, 127.21000], [37.21012, 127.21022], [37.21022, 127.21022], [37.21022, 127.21000]] };
  var r2 = clusterBuildings([c1, c2, c3]);
  assert.strictEqual(r2.splitCount, 1, '케이스2 실패: 인접 건물 3개가 하나로 안 묶임');
  assert.ok(r2.clusters[0].areaRatio < AREA_RATIO_WARN, '케이스2 실패: 면적비가 부당하게 큼(' + r2.clusters[0].areaRatio + ')');

  // 케이스 3: L자 배치(간격은 0m로 붙어있지만 껍질이 가운데 빈 사각형을 통째로 삼킴) -> 병합은 되지만 면적비 REVIEW 떠야 함
  var l1 = { id: 'L1', name: 'L자-왼쪽', footprint: [[37.22000, 127.22000], [37.22000, 127.22005], [37.22040, 127.22005], [37.22040, 127.22000]] };
  var l2 = { id: 'L2', name: 'L자-아래', footprint: [[37.22000, 127.22000], [37.22000, 127.22040], [37.22005, 127.22040], [37.22005, 127.22000]] };
  var r3 = clusterBuildings([l1, l2]);
  assert.strictEqual(r3.splitCount, 1, '케이스3 실패: L자 배치가 안 묶임(간격은 0m라 묶여야 정상)');
  assert.ok(r3.clusters[0].areaFlag, '케이스3 실패: 빈 공간을 삼킨 L자 배치가 REVIEW로 안 뜸');

  // 케이스 4: 용도코드 혼재(상업+공동주택) -> useFlag 떠야 함
  var u1 = { id: 'U1', name: '상가', useCode: '04000', footprint: [[37.23000, 127.23000], [37.23000, 127.23010], [37.23010, 127.23010], [37.23010, 127.23000]] };
  var u2 = { id: 'U2', name: '아파트동', useCode: '02000', footprint: [[37.23000, 127.23012], [37.23000, 127.23022], [37.23010, 127.23022], [37.23010, 127.23012]] };
  var r4 = clusterBuildings([u1, u2]);
  assert.strictEqual(r4.splitCount, 1, '케이스4 실패: 인접 두 건물이 안 묶임');
  assert.ok(r4.clusters[0].useFlag, '케이스4 실패: 상업+공동주택 혼재가 useFlag로 안 뜸');

  // 케이스 5: [정후 Critical 재현/회귀방지] 60m급 건물 3개를 25m 간격으로 사슬 배치 -> A-C는 110m라 절대 한 군집이 되면 안 됨
  // 미터->도(deg) 역산 헬퍼(정후 지적 — 손으로 도 단위를 적으면 라벨과 실측이 어긋남). 위도는 110540, 경도는 111320*cos(위도)로 스케일이 다름.
  function metersToLatDeg(m) { return m / 110540; }
  function metersToLngDeg(m, atLatDeg) { return m / (111320 * Math.cos(toRad(atLatDeg))); }
  function squareFootprintM(baseLat, baseLng, sizeM) {
    var latSpan = metersToLatDeg(sizeM);
    var lngSpan = metersToLngDeg(sizeM, baseLat + latSpan / 2);
    return [[baseLat, baseLng], [baseLat, baseLng + lngSpan], [baseLat + latSpan, baseLng + lngSpan], [baseLat + latSpan, baseLng]];
  }
  var SIZE_M = 60, GAP_M = 25;
  var stepLatDeg = metersToLatDeg(SIZE_M + GAP_M);
  var chainA = { id: 'CH-A', name: '체인상가A', footprint: squareFootprintM(37.24000, 127.24000, SIZE_M) };
  var chainB = { id: 'CH-B', name: '체인상가B', footprint: squareFootprintM(37.24000 + stepLatDeg, 127.24000, SIZE_M) };
  var chainC = { id: 'CH-C', name: '체인상가C', footprint: squareFootprintM(37.24000 + 2 * stepLatDeg, 127.24000, SIZE_M) };
  var r5 = clusterBuildings([chainA, chainB, chainC]);
  assert.strictEqual(r5.splitCount, 2, '케이스5 실패(Critical 회귀): 25m/25m/110m 사슬이 1개 군집으로 뚫림 — 정후가 지적한 사고 재발');
  r5.clusters.forEach(function(c) {
    assert.ok(c.maxInternalGapM <= GAP_THRESHOLD_M, '케이스5 실패(Critical 회귀): 군집 내부 최대간격이 임계값을 넘음(' + c.maxInternalGapM + 'm) - ' + c.names.join(','));
    assert.strictEqual(c.gapFlag, false, '케이스5 실패: gapFlag 불변식 위반');
  });

  // 케이스 6: [Important #2 회귀방지] 순수 아파트 2개 군집도 useFlag가 떠야 함(혼재가 아니어도)
  var ap1 = { id: 'AP1', name: '아파트A동', useCode: '02000', footprint: [[37.25000, 127.25000], [37.25000, 127.25010], [37.25010, 127.25010], [37.25010, 127.25000]] };
  var ap2 = { id: 'AP2', name: '아파트B동', useCode: '02000', footprint: [[37.25000, 127.25012], [37.25000, 127.25022], [37.25010, 127.25022], [37.25010, 127.25012]] };
  var r6 = clusterBuildings([ap1, ap2]);
  assert.strictEqual(r6.clusters[0].useFlag, true, '케이스6 실패: 순수 아파트 군집이 useFlag=false로 무경고 통과');

  // 케이스 7: [Important #3 회귀방지] useCode 미기입 = unknownUseFlag(확인 안 됨)이지 useFlag=false(문제 없음)와 달라야 함
  var unk1 = { id: 'UNK1', name: '용도미확인건물1', footprint: [[37.26000, 127.26000], [37.26000, 127.26010], [37.26010, 127.26010], [37.26010, 127.26000]] };
  var r7 = clusterBuildings([unk1]);
  assert.strictEqual(r7.clusters[0].unknownUseFlag, true, '케이스7 실패: useCode 미기입인데 unknownUseFlag=false');
  assert.strictEqual(r7.clusters[0].useFlag, false, '케이스7 실패: 미확인 상태에서 useFlag가 잘못 true');

  // 케이스 8: [Nice-to-have #1 회귀방지] gapThresholdM:0을 넘기면 실제로 0으로 적용돼야 함(폴백으로 30 쓰면 안 됨)
  var g1 = { id: 'G1', name: '건물g1', footprint: [[37.27000, 127.27000], [37.27000, 127.27010], [37.27010, 127.27010], [37.27010, 127.27000]] };
  var g2GapLat = 37.27010 + metersToLatDeg(25); // g1 상단에서 정확히 25m
  var g2 = { id: 'G2', name: '건물g2(25m 이격)', footprint: [[g2GapLat, 127.27000], [g2GapLat, 127.27010], [g2GapLat + 0.00010, 127.27010], [g2GapLat + 0.00010, 127.27000]] };
  var r8 = clusterBuildings([g1, g2], { gapThresholdM: 0 });
  assert.strictEqual(r8.splitCount, 2, '케이스8 실패: gapThresholdM:0이 30으로 폴백됨(25m 이격인데 병합됨)');

  // 케이스 9: [Nice-to-have #2 회귀방지] 꼭짓점 2개짜리 퇴화 footprint는 즉시 에러
  var bad = { id: 'BAD', name: '퇴화건물', footprint: [[37.28000, 127.28000], [37.28000, 127.28010]] };
  assert.throws(function() { clusterBuildings([bad]); }, /꼭짓점/, '케이스9 실패: 꼭짓점 부족 에러가 안 뜨거나 다른 종류의 오류로 통과함');

  console.log('merge_guard.js 자체테스트 9/9 PASS (정후 Critical 1건 + Important 3건 + Nice-to-have 2건 회귀테스트 포함)');
  console.log('');
  console.log('--- 예시 리포트(케이스 2) ---');
  console.log(auditReport([c1, c2, c3]));
  console.log('');
  console.log('--- 예시 리포트(케이스 5, 사슬 회귀방지) ---');
  console.log(auditReport([chainA, chainB, chainC]));
}
