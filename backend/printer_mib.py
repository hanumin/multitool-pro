# ═══════════════════════════════════════════════════════════════
# printer_mib.py — SNMP Printer MIB probe (RFC 3805 + RFC 2790)
# ═══════════════════════════════════════════════════════════════
# Thuần Python, KHÔNG dependency (pip bị chặn trong môi trường này).
# Triển khai client SNMPv1 tối thiểu (BER encode/decode) + đọc:
#   - Tổng số trang đã in  : prtMarkerLifeCount  (1.3.6.1.2.1.43.10.2.1.4)
#   - Toner / Drum / Ink % : prtMarkerSupplies*  (1.3.6.1.2.1.43.11.1.1)
#   - Trạng thái thiết bị  : prtGeneralStatus   (1.3.6.1.2.1.43.5.1.1)
#                            hrDeviceStatus      (1.3.6.1.2.1.25.3.2.1.5)
#
# Kỹ thuật (OID set + cách tính %) giống các repo cộng đồng được đánh giá cao:
#   - Nexuist/Cartriage            (SNMP → % supplies cho toner/drum/fuser)
#   - alfonsrv/printer-monitoring  (SNMP → page counter + consumables)
#   - bieniu/brother               (SNMP → Brother drum/toner %, page counts)
#
# Lưu ý: SNMP chỉ hoạt động với máy in CÓ MẠNG (IP). Máy in USB không có
# SNMP daemon → không đọc được bằng module này (xem manual supplies trong UI).
# ═══════════════════════════════════════════════════════════════

import re
import socket
import time

# ─── OID constants (RFC 3805 Printer MIB / RFC 2790 Host Resources) ───
OID_PRT_GENERAL = '1.3.6.1.2.1.43.5.1.1'        # prtGeneralTable (status, ...)
OID_PRT_MARKER = '1.3.6.1.2.1.43.10.2.1'        # prtMarkerTable
OID_PRT_MARKER_LIFE = '1.3.6.1.2.1.43.10.2.1.4' # prtMarkerLifeCount (cột 4)
OID_PRT_SUPPLIES = '1.3.6.1.2.1.43.11.1.1'      # prtMarkerSuppliesTable
OID_HR_DEVICE = '1.3.6.1.2.1.25.3.2.1'          # hrDeviceTable
OID_HR_DEVICE_STATUS = '1.3.6.1.2.1.25.3.2.1.5' # hrDeviceStatus (cột 5)

SNMP_PORT = 161
SNMP_VERSION_1 = 0

# Tag bytes
_TAG_INTEGER = 0x02
_TAG_OCTET = 0x04
_TAG_NULL = 0x05
_TAG_OID = 0x06
_TAG_SEQ = 0x30
_TAG_GET = 0xA0
_TAG_GETNEXT = 0xA1
_TAG_RESPONSE = 0xA2
# Response value types
_TAG_COUNTER32 = 0x41
_TAG_GAUGE32 = 0x42
_TAG_TIMETICKS = 0x43
_TAG_COUNTER64 = 0x46
_TAG_NOSUCHOBJECT = 0x80
_TAG_NOSUCHINSTANCE = 0x81
_TAG_ENDOFMIB = 0x82

# ─── BER helpers ────────────────────────────────────────────────

# WHY: Mã hoá độ dài BER (short form < 0x80, long form có prefix 0x80 + số byte).
def _encode_len(n):
    """Mã hoá độ dài BER (short/long form)."""
    if n < 0x80:
        return bytes([n])
    out = []
    while n:
        out.insert(0, n & 0xFF)
        n >>= 8
    return bytes([0x80 | len(out)]) + bytes(out)

# WHY: Mã hoá TLV (Tag-Length-Value) BER cơ bản.
def _encode_tlv(tag, data):
    return bytes([tag]) + _encode_len(len(data)) + data

def _encode_int(n):
    """INTEGER: two's complement tối thiểu (hỗ trợ cả số âm — sentinel -1/-2/-3)."""
    if n == 0:
        return b'\x00'
    if n > 0:
        out = bytearray()
        v = n
        while v:
            out.insert(0, v & 0xFF)
            v >>= 8
        if out[0] & 0x80:
            out.insert(0, 0x00)  # tránh hiểu nhầm số âm
        return bytes(out)
    # Số âm → two's complement tối thiểu: (1 << 8k) + n
    nbytes = (n.bit_length() + 8) // 8
    return ((1 << (8 * nbytes)) + n).to_bytes(nbytes, 'big')

# WHY: Mã hoá OID dạng chuỗi '1.3.6...' → bytes base-128 (2 sub-ident đầu gộp thành 40*first+second).
def _encode_oid(oid):
    parts = [int(x) for x in oid.split('.')]
    out = bytearray()
    # 2 sub-ident đầu gộp: 40*first + second
    first = parts[0] * 40 + parts[1] if len(parts) > 1 else parts[0]
    out += _encode_base128(first)
    for p in parts[2:]:
        out += _encode_base128(p)
    return bytes(out)

# WHY: Mã hoá sub-identifier base-128 (bit 7 đánh dấu tiếp tục).
def _encode_base128(n):
    if n < 0x80:
        return bytes([n])
    out = []
    while n:
        out.insert(0, (n & 0x7F) | (0x80 if out else 0))
        n >>= 7
    return bytes(out)

# WHY: Bọc nhiều TLV vào 1 SEQUENCE (cấu trúc message SNMP).
def _encode_seq(*tlvs):
    return _encode_tlv(_TAG_SEQ, b''.join(tlvs))

def _encode_oid_tlv(oid):
    return _encode_tlv(_TAG_OID, _encode_oid(oid))

# WHY: Tạo TLV NULL (value rỗng trong varbind của GET/GETNEXT).
def _encode_null_tlv():
    return bytes([_TAG_NULL, 0])

# ─── BER decode ─────────────────────────────────────────────────

# WHY: Giải mã độ dài BER (short/long form) → (length, pos_sau).
def _decode_length(buf, pos):
    first = buf[pos]
    pos += 1
    if first < 0x80:
        return first, pos
    nbytes = first & 0x7F
    n = 0
    for _ in range(nbytes):
        n = (n << 8) | buf[pos]
        pos += 1
    return n, pos

# WHY: Giải mã OID từ bytes base-128 → chuỗi '1.3.6...' (tách 2 sub-ident đầu ngược với encode).
def _decode_oid(buf, pos):
    """Decode OID (base-128 sub-ids) → str, trả (oid, pos_sau)."""
    parts = []
    n = 0
    first = True
    while pos < len(buf):
        b = buf[pos]
        pos += 1
        n = (n << 7) | (b & 0x7F)
        if not (b & 0x80):
            if first:
                # 2 sub-id đầu gộp: 40*first + second
                if n < 40:
                    parts = [0, n]
                elif n < 80:
                    parts = [1, n - 40]
                else:
                    parts = [2, n - 80]
                first = False
            else:
                parts.append(n)
            n = 0
    return '.'.join(str(p) for p in parts), pos

# WHY: Tách 1 TLV từ buffer → (tag, data, pos_sau).
def _parse_tlv(buf, pos):
    tag = buf[pos]
    pos += 1
    length, pos = _decode_length(buf, pos)
    data = buf[pos:pos + length]
    return tag, data, pos + length

# WHY: Chuyển value bytes từ response SNMP → int/str/None theo tag (xử lý INTEGER âm, COUNTER, OCTET, sentinel).
def _parse_value(tag, data):
    """Chuyển value từ response SNMP → int/str/None."""
    if tag == _TAG_INTEGER or tag == _TAG_COUNTER32 or tag == _TAG_GAUGE32:
        n = 0
        for b in data:
            n = (n << 8) | b
        # Xử lý dấu (INTEGER có thể âm — sentinel -1/-2/-3)
        if tag == _TAG_INTEGER and data and data[0] & 0x80:
            n -= 1 << (8 * len(data))
        return n
    if tag == _TAG_COUNTER64:
        n = 0
        for b in data:
            n = (n << 8) | b
        return n
    if tag == _TAG_TIMETICKS:
        n = 0
        for b in data:
            n = (n << 8) | b
        return n
    if tag == _TAG_OCTET:
        return data.decode('utf-8', errors='replace')
    if tag in (_TAG_NOSUCHOBJECT, _TAG_NOSUCHINSTANCE, _TAG_ENDOFMIB):
        return None
    return None

# WHY: Dựng message SNMPv1 GET/GETNEXT: version + community + PDU (request-id, error-status, error-index, varbind).
def _build_request(request_id, community, oid, pdu_tag):
    varbind = _encode_seq(_encode_oid_tlv(oid), _encode_null_tlv())
    varbinds = _encode_seq(varbind)
    int_tlv = lambda n: _encode_tlv(_TAG_INTEGER, _encode_int(n))
    pdu = _encode_tlv(pdu_tag, int_tlv(request_id) + int_tlv(0) + int_tlv(0) + varbinds)
    msg = _encode_seq(
        _encode_tlv(_TAG_INTEGER, _encode_int(SNMP_VERSION_1)) +
        _encode_tlv(_TAG_OCTET, community.encode('latin-1')) +
        pdu
    )
    return msg

# WHY: Parse GetResponse → (error_status, [(oid, value)]) — bỏ qua version/community, đọc varbind list.
def _parse_response(payload):
    """Parse GetResponse → (error_status, list[(oid, value)])"""
    tag, data, _ = _parse_tlv(payload, 0)
    if tag != _TAG_SEQ:
        return None, []
    # SEQUENCE gồm: version, community, PDU — parse tuần tự
    _, _d, pos = _parse_tlv(data, 0)
    _, _d, pos = _parse_tlv(data, pos)
    tag2, body, _ = _parse_tlv(data, pos)
    if tag2 != _TAG_RESPONSE:
        return None, []
    # request-id, error-status, error-index
    _, _d, pos = _parse_tlv(body, 0)
    _, err, pos = _parse_tlv(body, pos)
    error_status = int.from_bytes(err, 'big') if err else 0
    _, _d, pos = _parse_tlv(body, pos)
    # varbind list
    _, vbseq, _ = _parse_tlv(body, pos)
    vbs = []
    p = 0
    while p < len(vbseq):
        _, entry, p2 = _parse_tlv(vbseq, p)
        _, oid_data, p3 = _parse_tlv(entry, 0)  # OID
        oid_str, _ = _decode_oid(oid_data, 0)
        # value TLV
        vtag, vdata, _ = _parse_tlv(entry, p3)
        val = _parse_value(vtag, vdata)
        vbs.append((oid_str, val))
        p = p2
    return error_status, vbs

# ─── SNMP operations ────────────────────────────────────────────

# WHY: Gửi UDP + chờ response với timeout — trả payload bytes hoặc None (timeout/OSError).
def _snmp_send(ip, port, pkt, timeout):
    """Gửi UDP + chờ response. Trả payload bytes hoặc None."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(pkt, (ip, port))
        data, _ = sock.recvfrom(65535)
        return data
    except (socket.timeout, OSError):
        return None
    finally:
        sock.close()

# WHY: SNMPv1 GET → value đơn (int/str) hoặc None; retry theo số lần cấu hình.
def snmp_get(ip, oid, community='public', port=SNMP_PORT, timeout=2.5, retries=1):
    """SNMPv1 GET → value (int/str) hoặc None."""
    rid = int(time.time() * 1000) & 0x7FFFFFFF
    pkt = _build_request(rid, community, oid, _TAG_GET)
    for _ in range(retries + 1):
        resp = _snmp_send(ip, port, pkt, timeout)
        if not resp:
            continue
        err, vbs = _parse_response(resp)
        if err == 0 and vbs:
            return vbs[0][1]
    return None

# WHY: SNMPv1 GETNEXT → (next_oid, value) — nền tảng cho walk.
def snmp_getnext(ip, oid, community='public', port=SNMP_PORT, timeout=2.5, retries=1):
    """SNMPv1 GETNEXT → (next_oid, value) hoặc None."""
    rid = int(time.time() * 1000) & 0x7FFFFFFF
    pkt = _build_request(rid, community, oid, _TAG_GETNEXT)
    for _ in range(retries + 1):
        resp = _snmp_send(ip, port, pkt, timeout)
        if not resp:
            continue
        err, vbs = _parse_response(resp)
        if err == 0 and vbs:
            return vbs[0]
    return None

# WHY: SNMPv1 WALK bằng GETNEXT lặp — dừng khi ra khỏi nhánh base_oid, hết MIB view hoặc gặp OID trùng.
def snmp_walk(ip, base_oid, community='public', port=SNMP_PORT, timeout=2.5, max_rows=64):
    """
    SNMPv1 WALK (GETNEXT lặp) → list[(oid_str, value)].
    Dừng khi ra khỏi nhánh base_oid hoặc hết MIB view.
    """
    results = []
    current = base_oid
    seen = set()
    for _ in range(max_rows):
        nxt = snmp_getnext(ip, current, community, port, timeout)
        if not nxt:
            break
        oid, val = nxt
        if oid in seen:
            break
        seen.add(oid)
        if not oid.startswith(base_oid + '.'):
            break
        results.append((oid, val))
        current = oid
    return results

# ─── OID interpretation (RFC 3805) ──────────────────────────────
# prtMarkerSuppliesEntry — cột (sub-identifier):
#   1 index, 2 markerIndex, 3 class, 4 type, 5 description,
#   6 supplyUnit, 7 maxCapacity, 8 level, 9 lifeCount
# ⚠️ Một số triển khai cũ đánh số 8=maxCapacity, 9=level → resolve phòng thủ bên dưới.

# PrtMarkerSuppliesClassTC
_CLASS_TONER = 3
_CLASS_INK = 4
_CLASS_TONER_CONTAINER = 5
_CLASS_INK_CONTAINER = 6

# PrtMarkerSuppliesTypeTC (giá trị phổ biến)
_TYPE_TONER_CARTRIDGE = 3
_TYPE_WASTE_COLLECTOR = 5
_TYPE_INK_CARTRIDGE = 6
_TYPE_WASTE_TONER = 8
_TYPE_FUSER = 9
_TYPE_CORONA_WIRE = 10
_TYPE_TRANSFER_ROLLER = 11
_TYPE_MAINTENANCE_KIT = 12
_TYPE_DRUM_UNIT = 13
_TYPE_DEVELOPER_UNIT = 14
_TYPE_IMAGING_UNIT = 15

# PrtMarkerSuppliesSupplyUnitTC — unit có giá trị là percent
_UNIT_PERCENT = 19

# Sentinel values của level (PrtMarkerSuppliesLevelTC)
LEVEL_OTHER = -1
LEVEL_UNKNOWN = -2
LEVEL_SOME_REMAINING = -3

# prtGeneralStatus / hrDeviceStatus enum
_STATUS_GENERAL = {
    1: 'Khác', 2: 'Không rõ', 3: 'Rảnh (Idle)', 4: 'Đang xử lý', 5: 'Dừng',
}
_STATUS_HR = {
    1: 'Không rõ', 2: 'Hoạt động', 3: 'Cảnh báo', 4: 'Đang tự kiểm tra', 5: 'Ngừng (Offline)',
}


# WHY: Phân loại vật tư theo class/type RFC 3805 → toner|ink|drum|developer|waste|other (dùng cho icon + nhóm hiển thị).
def _supply_kind(cls, typ):
    """Phân loại vật tư theo class/type → toner|ink|drum|waste|other."""
    if typ in (_TYPE_DRUM_UNIT, _TYPE_IMAGING_UNIT):
        return 'drum'
    if typ in (_TYPE_DEVELOPER_UNIT,):
        return 'developer'
    if typ in (_TYPE_WASTE_COLLECTOR, _TYPE_WASTE_TONER):
        return 'waste'
    if typ in (_TYPE_FUSER, _TYPE_CORONA_WIRE, _TYPE_TRANSFER_ROLLER, _TYPE_MAINTENANCE_KIT):
        return 'other'
    if typ in (_TYPE_TONER_CARTRIDGE,) or cls in (_CLASS_TONER, _CLASS_TONER_CONTAINER):
        return 'toner'
    if typ in (_TYPE_INK_CARTRIDGE,) or cls in (_CLASS_INK, _CLASS_INK_CONTAINER):
        return 'ink'
    return 'other'


# WHY: Tạo tên hiển thị tiếng Việt cho vật tư — ưu tiên description từ máy in, fallback theo kind + màu.
def _supply_label(kind, description, color_hint):
    """Tạo tên hiển thị cho vật tư (tiếng Việt)."""
    if description and description.strip():
        return description.strip()
    labels = {
        'toner': 'Mực (Toner)', 'ink': 'Mực (Ink)', 'drum': 'Trống (Drum)',
        'developer': 'Developer', 'waste': 'Thùng mực thải', 'other': 'Vật tư',
    }
    base = labels.get(kind, 'Vật tư')
    if color_hint:
        return f'{base} ({color_hint})'
    return base


# WHY: Chọn (level, maxCapacity) từ dict cột — phòng thủ cho 2 cách đánh số MIB (chuẩn 7/8 vs cũ 8/9).
def _resolve_level_max(cols):
    """
    Chọn (level, maxCapacity) từ dict cột — phòng thủ cho 2 cách đánh số:
      A) max=7, level=8  (RFC 3805 chuẩn)
      B) max=8, level=9  (một số MIB cũ)
    Chỉ chấp nhận bộ hợp lệ: max >= 0 và level hợp lệ.
    """
    candidates = [
        (cols.get(7), cols.get(8)),
        (cols.get(8), cols.get(9)),
    ]
    for maxc, lvl in candidates:
        if lvl is None:
            continue
        if isinstance(maxc, int) and isinstance(lvl, int) and maxc > 0:
            return lvl, maxc
        if isinstance(lvl, int):
            # Không có max (hoặc max=0) → chỉ có level
            return lvl, maxc if isinstance(maxc, int) and maxc > 0 else None
    return cols.get(8, cols.get(9)), cols.get(7, cols.get(8))


# WHY: Tính % vật tư còn lại: unit=percent → level trực tiếp; có max → level/max*100; sentinel (-1/-2/-3) → None + flag some_remaining.
def compute_percent(level, max_capacity, unit):
    """
    Tính % còn lại của vật tư.
    - unit == percent(19) → level chính là % (0-100)
    - max > 0           → level / max * 100
    - Sentinel (-1/-2/-3) → None (không tính được), trả flag some_remaining
    Returns: (percent|None, some_remaining: bool)
    """
    if level is None:
        return None, False
    if level == LEVEL_SOME_REMAINING:
        return None, True
    if level in (LEVEL_OTHER, LEVEL_UNKNOWN):
        return None, False
    if unit == _UNIT_PERCENT:
        return max(0, min(100, int(round(level)))), False
    if isinstance(max_capacity, int) and max_capacity > 0:
        pct = int(round(level / max_capacity * 100))
        return max(0, min(100, pct)), False
    return None, False


# ─── Probe tổng hợp ─────────────────────────────────────────────

# WHY: Probe 1 máy in qua SNMP: online/sysDescr → status (prtGeneralStatus, fallback hrDeviceStatus) → page_count → supplies (walk + gom theo instance).
def probe_printer_status(ip, community='public', port=SNMP_PORT, timeout=2.5, retries=1):
    """
    Probe một máy in qua SNMP (RFC 3805 / RFC 2790).

    Args:
        ip: Địa chỉ IP máy in
        community: SNMP community string (mặc định "public")
        port: UDP port (mặc định 161)
        timeout: Timeout mỗi lần gửi (giây)
        retries: Số lần gửi lại khi timeout (0 = chỉ gửi 1 lần — nhanh hơn)

    Returns:
        dict {
            'online': bool,
            'error': str|None,
            'page_count': int|None,
            'status': str|None,        # trạng thái tiếng Việt
            'status_code': int|None,
            'supplies': [ {name, kind, level, max, unit, percent, some_remaining, source} ],
            'model': str|None,         # sysDescr nếu đọc được
            'uptime': int|None,
        }
    """
    result = {
        'online': False, 'error': None, 'page_count': None, 'status': None,
        'status_code': None, 'supplies': [], 'model': None, 'uptime': None,
    }
    if not ip:
        result['error'] = 'Thiếu địa chỉ IP'
        return result

    # 1. Kiểm tra sống + lấy sysDescr (1.3.6.1.2.1.1.1.0)
    try:
        descr = snmp_get(ip, '1.3.6.1.2.1.1.1.0', community, port, timeout, retries)
        if descr:
            result['model'] = str(descr)[:120]
            result['online'] = True
    except Exception as e:
        result['error'] = f'Lỗi kết nối SNMP: {e}'
        return result
    if not result['online']:
        # Không có response → máy không hỗ trợ SNMP / sai IP / sai community
        result['error'] = 'Không có response SNMP (máy không hỗ trợ SNMP hoặc sai IP/community)'
        return result

    # 2. Trạng thái thiết bị
    try:
        st = snmp_get(ip, '1.3.6.1.2.1.43.5.1.1.1', community, port, timeout, retries)
        if st is not None:
            result['status_code'] = int(st)
            result['status'] = _STATUS_GENERAL.get(int(st), f'Mã {st}')
    except Exception:
        pass
    if result['status'] is None:
        try:
            hr = snmp_walk(ip, OID_HR_DEVICE_STATUS, community, port, timeout, max_rows=32)
            if hr:
                st = hr[0][1]
                if st is not None:
                    result['status_code'] = int(st)
                    result['status'] = _STATUS_HR.get(int(st), f'Mã {st}')
        except Exception:
            pass

    # 3. Tổng số trang đã in (prtMarkerLifeCount — cột 4 của prtMarkerTable)
    try:
        life = snmp_walk(ip, OID_PRT_MARKER_LIFE, community, port, timeout, max_rows=16)
        counts = [int(v) for oid, v in life if isinstance(v, int) and v > 0]
        if counts:
            result['page_count'] = max(counts)
    except Exception:
        pass

    # 4. Vật tư (toner/drum/ink) — walk toàn bộ bảng supplies
    try:
        rows = snmp_walk(ip, OID_PRT_SUPPLIES, community, port, timeout, max_rows=256)
        # Gom theo supply instance — cấu trúc OID: base.<cột>.<instance>
        # (VD: ...43.11.1.1.8.1 → cột 8 = level, instance 1)
        supplies_map = {}
        for oid, val in rows:
            if val is None:
                continue
            rest = oid[len(OID_PRT_SUPPLIES) + 1:]
            parts = rest.split('.')
            if len(parts) < 2:
                continue
            try:
                col = int(parts[0])
                idx = '.'.join(parts[1:])
            except ValueError:
                continue
            supplies_map.setdefault(idx, {})[col] = val

        for idx, cols in supplies_map.items():
            cls = cols.get(3)
            typ = cols.get(4)
            unit = cols.get(6)
            desc = cols.get(5)
            kind = _supply_kind(cls, typ)
            level, maxc = _resolve_level_max(cols)
            percent, some_remaining = compute_percent(level, maxc, unit)
            # Color hint từ description (VD "Black Toner", "Cyan Ink")
            color_hint = None
            if isinstance(desc, str):
                low = desc.lower()
                for c in ('black', 'cyan', 'magenta', 'yellow', 'photo'):
                    if c in low:
                        color_hint = c.capitalize()
                        break
            result['supplies'].append({
                'name': _supply_label(kind, desc if isinstance(desc, str) else None, color_hint),
                'kind': kind,
                'level': level,
                'max': maxc,
                'unit': int(unit) if isinstance(unit, int) else None,
                'percent': percent,
                'some_remaining': some_remaining,
                'source': 'snmp',
            })

        # Sắp xếp: toner/ink trước, drum, còn lại
        order = {'toner': 0, 'ink': 1, 'drum': 2, 'developer': 3, 'waste': 4, 'other': 5}
        result['supplies'].sort(key=lambda s: (order.get(s['kind'], 9), s['name']))
    except Exception:
        pass

    return result


# ─── Ghép thiết bị quét được với máy in Windows ─────────────────
# Sau khi scan tìm thấy thiết bị (model từ sysDescr), gợi ý xem nó là
# máy in nào trong danh sách máy in Windows local (VD thiết bị có model
# "EPSON EP-804A series" ↔ máy in local "EPSON EP-804A").

# Từ chung bỏ qua khi so khớp (không mang thông tin model cụ thể)
_IGNORE_WORDS = {'series', 'printer', 'laser', 'ink', 'jet', 'color', 'colour',
                 'multifunction', 'all', 'one', 'aio', 'mono', 'monochrome',
                 'photo', 'plus', 'pro', 'workgroup', 'office', 'deskjet',
                 'officejet', 'designjet', 'labelwriter', 'multifunktion'}

# Ngưỡng confidence tối thiểu để gợi ý ghép
MATCH_THRESHOLD = 0.55


# WHY: Chuẩn hóa tên/model để so khớp: lowercase, chỉ giữ chữ+số, gom khoảng trắng.
def _normalize_match(s):
    """Chuẩn hóa tên/model: lowercase, chỉ giữ chữ+số, gom khoảng trắng."""
    s = (s or '').lower()
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return ' '.join(s.split())


# WHY: Token hóa + lọc từ chung (series/printer/laser...) — chỉ giữ token mang thông tin model.
def _match_tokens(norm):
    """Token hóa + lọc từ chung."""
    return [w for w in norm.split() if w not in _IGNORE_WORDS]


# WHY: Tìm máy in Windows khớp nhất với model thiết bị — containment→0.92, còn lại Jaccard thuần (KHÔNG bonus để tránh ghép nhầm EP-804A/EP-904A).
def suggest_printer_match(device_model, printer_names):
    """
    Tìm máy in Windows khớp nhất với model thiết bị quét được.

    Args:
        device_model: Model/description từ sysDescr (VD "EPSON EP-804A series")
        printer_names: Danh sách tên máy in local (VD ["EPSON EP-804A", ...])

    Returns:
        (tên máy in, confidence 0-1) hoặc None nếu không đủ khớp (dưới ngưỡng).

    Cách tính confidence:
        - Chuẩn hóa trùng khớp tuyệt đối         → 1.0
        - 1 chuỗi chứa chuỗi kia (sau bỏ từ chung) → 0.92
        - Ngược lại: Jaccard theo token (thuần, KHÔNG bonus)

    ⚠️ Không dùng bonus cho "nhiều token chung": device "EPSON EP-804A"
    vs printer "EPSON EP-904A" chung {epson, ep} → Jaccard 0.5 (< ngưỡng)
    → đúng vì là 2 máy in KHÁC NHAU. Bonus cũ (0.5 + inter*0.15) từng
    ghép nhầm cặp này thành "khớp 0.8".
    """
    if not device_model or not printer_names:
        return None
    device_norm = _normalize_match(device_model)
    device_toks = set(_match_tokens(device_norm))
    best_name = None
    best_score = 0.0
    for name in printer_names:
        if not name:
            continue
        p_norm = _normalize_match(name)
        if not p_norm:
            continue
        if p_norm == device_norm:
            return (name, 1.0)
        if p_norm in device_norm or device_norm in p_norm:
            # Một bên là subset của bên kia (sai khác chỉ ở từ chung như "series")
            score = 0.92
        else:
            p_toks = set(_match_tokens(p_norm))
            if not p_toks or not device_toks:
                score = 0.0
            else:
                union = len(p_toks | device_toks)
                score = len(p_toks & device_toks) / union if union else 0.0
        if score > best_score:
            best_score = score
            best_name = name
    if best_name and best_score >= MATCH_THRESHOLD:
        return (best_name, round(best_score, 2))
    return None


# WHY: Gán matched_printer ({name, confidence}) cho từng thiết bị quét được dựa trên suggest_printer_match.
def annotate_device_matches(devices, printer_names):
    """
    Gán matched_printer cho từng thiết bị quét được:
        d['matched_printer'] = {'name': str, 'confidence': float} | None
    """
    for d in devices:
        model = d.get('model') or d.get('printer_name') or ''
        m = suggest_printer_match(model, printer_names)
        d['matched_printer'] = {'name': m[0], 'confidence': m[1]} if m else None
    return devices


# ─── LAN scan — tự phát hiện IP máy in (SNMP port 161) ───────────
# Khi người dùng muốn cấu hình IP cho máy in, thay vì đoán IP thủ công
# (hoặc vào router xem DHCP), quét cả dải mạng LAN: gửi SNMP GET sysDescr
# tới từng host — máy in (và thiết bị SNMP khác) sẽ trả lời kèm tên/model.

# Từ khóa trong sysDescr giúp nhận diện "gần như chắc chắn là máy in"
# khi OID RFC 3805 prtGeneralStatus không phản hồi (một số máy cũ/khác hãng).
# ⚠️ CHỈ giữ từ khóa MẠNH — tránh substring yếu ('dell', 'scanner', 'mf',
# 'thermal', 'fax') vì switch/router Dell cũng chứa "Dell" trong sysDescr
# → gắn nhãn "Máy in" sai. Tín hiệu chính vẫn là prtGeneralStatus.
_PRINTER_HINTS = (
    'printer', 'laserjet', 'laser jet', 'deskjet', 'officejet', 'photo smart',
    'epson', 'brother', 'canon', 'lexmark', 'ricoh', 'xerox', 'samsung',
    'kyocera', 'okidata', 'konica', 'minolta', 'panasonic',
    'multifunction', 'all-in-one', 'all in one', 'copier', 'photocopier',
    'plotter', 'labelwriter',
)


# WHY: Lấy IP local (IPv4) qua UDP connect trick tới 8.8.8.8 — không gửi gói tin thật.
def _get_local_ip():
    """IP local (IPv4) qua UDP connect trick — không gửi gói tin thật."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(('8.8.8.8', 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return '127.0.0.1'


# WHY: Subnet mặc định /24 quanh IP local (VD 192.168.1.50 → 192.168.1.0/24).
def get_default_subnet():
    """Subnet mặc định: /24 quanh IP local (VD 192.168.1.50 → 192.168.1.0/24)."""
    ip = _get_local_ip()
    return '.'.join(ip.split('.')[:3]) + '.0/24'


# WHY: Mở rộng CIDR → list IP (loại network/broadcast trừ /31, /32) — raise ValueError nếu mạng quá lớn để tránh quét nhầm /8, /16.
def _expand_cidr(cidr, max_hosts=2048):
    """
    Mở rộng CIDR → list IP (loại network/broadcast khi prefix < 31).
    Raise ValueError nếu mạng quá lớn (tránh quét nhầm /8, /16).
    """
    parts = cidr.strip().split('/')
    if len(parts) != 2:
        raise ValueError(f'CIDR không hợp lệ: {cidr} (VD: 192.168.1.0/24)')
    net_str, prefix_s = parts
    try:
        prefix = int(prefix_s)
        base = int.from_bytes(socket.inet_aton(net_str.strip()), 'big')
    except (ValueError, OSError):
        raise ValueError(f'CIDR không hợp lệ: {cidr}')
    if not 0 <= prefix <= 32:
        raise ValueError(f'Prefix không hợp lệ: {prefix}')
    size = 1 << (32 - prefix)
    if size > max_hosts * 4:
        raise ValueError(f'Mạng {cidr} quá lớn ({size} host) — giới hạn tối đa {max_hosts * 4} host')
    ips = []
    start = base + 1
    end = base + size - 2
    if prefix >= 31:
        # /31, /32: cả 2/1 địa chỉ đều dùng được
        start = base
        end = base + size - 1
    for i in range(start, end + 1):
        ips.append(socket.inet_ntoa(i.to_bytes(4, 'big')))
    return ips


# WHY: Probe nhanh 1 host qua SNMP (timeout ngắn, không retry, dành cho scan): sysDescr → model; prtGeneralStatus phản hồi = chắc chắn máy in, else fallback keyword sysDescr.
def probe_snmp_device(ip, community='public', port=SNMP_PORT, timeout=0.35):
    """
    Probe nhanh 1 host qua SNMP (timeout ngắn, không retry — dành cho scan).

    Returns:
        dict {'ip', 'model', 'printer_name', 'is_printer'} hoặc None nếu host
        không trả lời SNMP.
    """
    descr = snmp_get(ip, '1.3.6.1.2.1.1.1.0', community, port, timeout, 0)
    if not descr:
        return None
    device = {
        'ip': ip,
        'model': str(descr)[:120],
        'printer_name': None,
        'is_printer': False,
    }
    # RFC 3805 prtGeneralStatus chỉ tồn tại trên máy in → phản hồi = chắc chắn máy in
    st = snmp_get(ip, '1.3.6.1.2.1.43.5.1.1.1', community, port, timeout, 0)
    if st is not None:
        device['is_printer'] = True
        # prtGeneralDeviceName (cột 13) — tên thân thiện người dùng đặt
        name = snmp_get(ip, '1.3.6.1.2.1.43.5.1.1.13.1', community, port, timeout, 0)
        if name:
            device['printer_name'] = str(name)[:120]
        return device
    # Không có prtGeneralStatus → dựa vào sysDescr chứa từ khóa máy in
    low = str(descr).lower()
    if any(k in low for k in _PRINTER_HINTS):
        device['is_printer'] = True
    return device


# WHY: Sort IP theo số học (192.168.1.2 < 192.168.1.100) thay vì lexicographic.
def _ip_sort_key(ip):
    """Sort IP theo số học (192.168.1.2 < 192.168.1.100) thay vì lexicographic."""
    try:
        return tuple(int(x) for x in ip.split('.'))
    except (ValueError, AttributeError):
        return (0, 0, 0, 0)


# WHY: Quét LAN tìm thiết bị SNMP (máy in) trong subnet — ThreadPoolExecutor 128 workers, máy in xác nhận lên trước.
def scan_lan_printers(subnet=None, community='public', port=SNMP_PORT,
                      timeout=0.35, max_workers=128):
    """
    Quét LAN tìm thiết bị SNMP (máy in) trong một subnet.

    Args:
        subnet: CIDR (VD "192.168.1.0/24"). Mặc định: /24 quanh IP local.
        community: SNMP community string để probe (mặc định "public").
        port: UDP port (mặc định 161).
        timeout: Timeout mỗi lần gửi (giây) — ngắn để quét nhanh.
        max_workers: Số luồng song song.

    Returns:
        dict {'devices': [...], 'subnet', 'scanned', 'duration_ms', 'error'?}
        devices: [{'ip', 'model', 'printer_name', 'is_printer'}] sắp xếp máy in trước.
    """
    t0 = time.time()
    if not subnet:
        subnet = get_default_subnet()
    try:
        ips = _expand_cidr(subnet)
    except Exception as e:
        return {'devices': [], 'subnet': subnet, 'scanned': 0, 'duration_ms': 0,
                'error': str(e)}
    own_ip = _get_local_ip()
    targets = [ip for ip in ips if ip != own_ip]

    from concurrent.futures import ThreadPoolExecutor
    devices = []
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = [ex.submit(probe_snmp_device, ip, community, port, timeout)
                   for ip in targets]
        for fut in futures:
            try:
                d = fut.result()
                if d:
                    devices.append(d)
            except Exception:
                pass  # host lỗi cá biệt → bỏ qua, không làm hỏng cả scan

    # Máy in xác nhận lên trước, thiết bị SNMP khác sau; IP sort theo số học
    devices.sort(key=lambda d: (not d['is_printer'], _ip_sort_key(d['ip'])))
    return {
        'devices': devices,
        'subnet': subnet,
        'scanned': len(targets),
        'duration_ms': int((time.time() - t0) * 1000),
    }


# ─── Utilities ──────────────────────────────────────────────────
