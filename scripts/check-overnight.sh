#!/usr/bin/env bash
# Kiểm tra sức khỏe phiên qua đêm — chạy sáng mai sau khi để exe chạy suốt đêm.
# Cách dùng:  bash scripts/check-overnight.sh
# Kết quả: in 3 phần — TRẠNG THÁI (OK/FAIL từng mục), CHI TIẾT, KẾT LUẬN.

LOG="$APPDATA/multitool-pro/debug.log"
OLD="$APPDATA/multitool-pro/debug.log.old"
PORT=5050

echo "════════════════════════════════════════════════════════"
echo "  CHECK PHIÊN QUA ĐÊM — $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════════════════"
echo "debug.log : $LOG"
echo "debug.log.old : $OLD"
echo

PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

# ── 1. Backend còn sống không ─────────────────────────────────
echo "── [1] Backend (port $PORT) ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$PORT/api/preload" 2>/dev/null)
if [ "$CODE" = "200" ]; then ok "Backend đang chạy — preload HTTP $CODE"; else bad "Backend KHÔNG phản hồi (HTTP '$CODE')"; fi
echo

# ── 2. File log phiên ─────────────────────────────────────────
echo "── [2] File log phiên ──"
if [ -f "$LOG" ]; then
    LINES=$(wc -l < "$LOG" | tr -d ' ')
    ok "debug.log tồn tại — $LINES dòng"
else
    bad "KHÔNG có debug.log — backend chưa từng ghi?"
fi
echo

# ── 3. Header phiên: đúng 1 lần ───────────────────────────────
echo "── [3] Header phiên ──"
HC=$(grep -c "PHIÊN MỚI BẮT ĐẦU" "$LOG" 2>/dev/null)
if [ "$HC" = "1" ]; then
    ok "Header phiên đúng 1 lần (không bị restart backend ghi thêm)"
    grep "PHIÊN MỚI BẮT ĐẦU" "$LOG" | head -1
elif [ "$HC" = "0" ]; then
    bad "Không có header phiên — exe có thể KHÔNG phải bản 14:55+"
else
    bad "Header $HC lần — kỳ lạ, kiểm tra tay"
fi
echo

# ── 4. Lỗi [audio][ERROR] ─────────────────────────────────────
echo "── [4] Lỗi [audio][ERROR] ──"
AE=$(grep -c "\[audio\]\[ERROR\]" "$LOG" 2>/dev/null)
if [ "$AE" = "0" ]; then
    ok "0 lỗi [audio][ERROR] trong toàn phiên"
else
    bad "$AE lỗi [audio][ERROR] — xem chi tiết bên dưới"
    grep "\[audio\]\[ERROR\]" "$LOG" | tail -5
fi
echo

# ── 5. Lỗi DirectSound / monitor fail ─────────────────────────
echo "── [5] Monitor mic-level ──"
DS=$(grep -c "DirectSound error\|Unanticipated host error" "$LOG" 2>/dev/null)
MON=$(grep -c "Monitor started on device" "$LOG" 2>/dev/null)
echo "  Monitor start: $MON lần | Host error (DirectSound/WASAPI fail): $DS lần"
if [ "$DS" -le 3 ]; then
    ok "Host error ≤ 3 lần (fail transient đầu phiên là bình thường, MME fallback lo)"
else
    bad "$DS lần host error — nghiêm trọng nếu monitor KHÔNG start sau đó"
fi
# Monitor cuối phải bám đúng thiết bị
LAST_MON=$(grep "Monitor started on device" "$LOG" | tail -1)
if [ -n "$LAST_MON" ]; then
    echo "  Lần start cuối: $LAST_MON"
    if echo "$LAST_MON" | grep -q "PD200X"; then ok "Monitor bám đúng PD200X"; else echo "  (thiết bị không phải PD200X — kiểm tra xem đúng mic bạn đang dùng không)"; fi
fi
echo

# ── 6. Độ dài phiên ───────────────────────────────────────────
echo "── [6] Độ dài phiên ──"
START=$(grep "PHIÊN MỚI BẮT ĐẦU" "$LOG" | head -1 | grep -oE "[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}")
MTIME=$(stat -c "%y" "$LOG" 2>/dev/null | cut -d. -f1)
echo "  Bắt đầu phiên: $START"
echo "  Lần ghi cuối  : $MTIME"
echo

echo "════════════════════════════════════════════════════════"
if [ "$FAIL" = "0" ]; then
    echo "  ✅ KẾT LUẬN: PHIÊN QUA ĐÊM SẠCH — $PASS mục OK, 0 lỗi"
    echo "  Tab Nhật ký sẽ hiện đầy đủ log từ $START, không có [audio][ERROR]."
    exit 0
else
    echo "  ❌ KẾT LUẬN: CÓ $FAIL mục cần xem — log đã lưu, dán nội dung trên cho tôi debug."
    exit 1
fi
echo "════════════════════════════════════════════════════════"
