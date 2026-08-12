# ═══════════════════════════════════════════════════════════════
# test_printer_mib.py — Unit test printer_mib với mock SNMP agent
# (UDP server giả lập máy in trả về dữ liệu RFC 3805 giả).
# Chạy: python test_printer_mib.py
# ═══════════════════════════════════════════════════════════════

import socket
import threading
import time

import printer_mib as pm

MOCK_PORT = 16161  # port cao, tránh xung đột


# ─── Mock SNMP agent ────────────────────────────────────────────
# Bảng dữ liệu giả: OID → (tag, value)
# Tag: 'int' | 'str' | 'none'
FAKE_TABLE = {
    '1.3.6.1.2.1.1.1.0': ('str', 'EPSON Mock Printer 5000 series'),
    '1.3.6.1.2.1.1.3.0': ('int', 123456),  # uptime
    '1.3.6.1.2.1.43.5.1.1.1': ('int', 4),  # prtGeneralStatus = processing
    '1.3.6.1.2.1.43.10.2.1.4.1.1': ('int', 12345),  # marker 1 life count
    # ── Supply 1: Black Toner (class=3 toner, type=3 cartridge, unit=11 grams) ──
    '1.3.6.1.2.1.43.11.1.1.1.1': ('int', 1),
    '1.3.6.1.2.1.43.11.1.1.2.1': ('int', 1),
    '1.3.6.1.2.1.43.11.1.1.3.1': ('int', 3),
    '1.3.6.1.2.1.43.11.1.1.4.1': ('int', 3),
    '1.3.6.1.2.1.43.11.1.1.5.1': ('str', 'Black Toner'),
    '1.3.6.1.2.1.43.11.1.1.6.1': ('int', 11),
    '1.3.6.1.2.1.43.11.1.1.7.1': ('int', 100),  # maxCapacity
    '1.3.6.1.2.1.43.11.1.1.8.1': ('int', 35),   # level → 35%
    # ── Supply 2: Drum Unit (type=13 drumUnit, unit=19 percent) ──
    '1.3.6.1.2.1.43.11.1.1.1.2': ('int', 2),
    '1.3.6.1.2.1.43.11.1.1.2.2': ('int', 1),
    '1.3.6.1.2.1.43.11.1.1.3.2': ('int', 2),
    '1.3.6.1.2.1.43.11.1.1.4.2': ('int', 13),
    '1.3.6.1.2.1.43.11.1.1.5.2': ('str', 'Drum Unit'),
    '1.3.6.1.2.1.43.11.1.1.6.2': ('int', 19),   # percent
    '1.3.6.1.2.1.43.11.1.1.7.2': ('int', 100),
    '1.3.6.1.2.1.43.11.1.1.8.2': ('int', 60),   # 60% trực tiếp
    # ── Supply 3: Waste Toner (type=8, level=-3 someRemaining) ──
    '1.3.6.1.2.1.43.11.1.1.1.3': ('int', 3),
    '1.3.6.1.2.1.43.11.1.1.2.3': ('int', 1),
    '1.3.6.1.2.1.43.11.1.1.3.3': ('int', 2),
    '1.3.6.1.2.1.43.11.1.1.4.3': ('int', 8),
    '1.3.6.1.2.1.43.11.1.1.5.3': ('str', 'Waste Toner Box'),
    '1.3.6.1.2.1.43.11.1.1.6.3': ('int', 11),
    '1.3.6.1.2.1.43.11.1.1.7.3': ('int', 100),
    '1.3.6.1.2.1.43.11.1.1.8.3': ('int', -3),   # someRemaining
}

_SORTED = sorted(FAKE_TABLE.items())


# WHY: Parse GetRequest/GetNextRequest từ bytes → (pdu_tag, request_id, oid, community) để mock agent trả lời đúng.
def _parse_request(data):
    """Parse GetRequest/GetNextRequest → (pdu_tag, request_id, oid, community)"""
    tag, body, _ = pm._parse_tlv(data, 0)
    assert tag == pm._TAG_SEQ
    _, d, pos = pm._parse_tlv(body, 0)      # version
    _, comm, pos = pm._parse_tlv(body, pos)  # community
    pdu_tag = body[pos]
    _, pdu_body, pos = pm._parse_tlv(body, pos)
    _, rid_d, pos = pm._parse_tlv(pdu_body, 0)
    rid = int.from_bytes(rid_d, 'big')
    _, _d, pos = pm._parse_tlv(pdu_body, pos)  # error-status
    _, _d, pos = pm._parse_tlv(pdu_body, pos)  # error-index
    _, vbl, _ = pm._parse_tlv(pdu_body, pos)
    _, entry, _ = pm._parse_tlv(vbl, 0)
    _, oid_d, _ = pm._parse_tlv(entry, 0)
    oid_str, _ = pm._decode_oid(oid_d, 0)
    return pdu_tag, rid, oid_str, comm.decode('latin-1')


# Community string mà mock agent chấp nhận (mô phỏng máy in bảo mật)
EXPECTED_COMMUNITY = 'public'


# WHY: Encode value theo tag kind ('str'→OCTET, 'none'→NULL, else INTEGER) khi dựng response giả.
def _encode_value(tag_kind, value):
    if tag_kind == 'str':
        return pm._encode_tlv(pm._TAG_OCTET, value.encode('utf-8'))
    if tag_kind == 'none':
        return pm._encode_null_tlv()
    return pm._encode_tlv(pm._TAG_INTEGER, pm._encode_int(value))


# WHY: Dựng GetResponse bytes theo đúng format SNMPv1 (version 0 + community + PDU) cho mock agent.
def _build_response(rid, varbinds):
    vbs = b''
    for oid, (kind, val) in varbinds:
        vbs += pm._encode_seq(pm._encode_oid_tlv(oid) + _encode_value(kind, val))
    int_tlv = lambda n: pm._encode_tlv(pm._TAG_INTEGER, pm._encode_int(n))
    pdu = pm._encode_tlv(pm._TAG_RESPONSE, int_tlv(rid) + int_tlv(0) + int_tlv(0) + pm._encode_seq(vbs))
    return pm._encode_seq(
        pm._encode_tlv(pm._TAG_INTEGER, pm._encode_int(0)) +
        pm._encode_tlv(pm._TAG_OCTET, b'public') + pdu)


# WHY: Xử lý 1 request: kiểm tra community (sai → không trả lời như máy in thật), GET → tra FAKE_TABLE, GETNEXT → entry đầu tiên lớn hơn oid.
def _handle_request(pkt, sock, addr):
    try:
        pdu_tag, rid, oid, community = _parse_request(pkt)
        if community != EXPECTED_COMMUNITY:
            return  # sai community → không response (như máy in thật)
        if pdu_tag == pm._TAG_GET:
            item = FAKE_TABLE.get(oid)
            vbs = [(oid, item)] if item else [(oid, ('none', None))]
        elif pdu_tag == pm._TAG_GETNEXT:
            # Tìm entry đầu tiên có OID > oid
            nxt = None
            for o, v in _SORTED:
                if o > oid:
                    nxt = (o, v)
                    break
            vbs = [nxt] if nxt else [(oid, ('none', None))]
        else:
            return
        sock.sendto(_build_response(rid, vbs), addr)
    except Exception as e:
        print(f'[mock-agent] error: {e}')


# WHY: Khởi động UDP server giả lập máy in trên port cao (tránh xung đột) — trả về socket để test close.
def start_mock_agent(port=MOCK_PORT, community='public'):
    global EXPECTED_COMMUNITY
    EXPECTED_COMMUNITY = community
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('127.0.0.1', port))
    sock.settimeout(0.2)

# WHY: Vòng lặp chính của mock agent: nhận gói → xử lý → trả lời; bỏ qua timeout, thoát khi socket đóng.
    def run():
        while True:
            try:
                pkt, addr = sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            _handle_request(pkt, sock, addr)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return sock


# ─── Tests ──────────────────────────────────────────────────────

def test_probe_full():
    sock = start_mock_agent()
    try:
        res = pm.probe_printer_status('127.0.0.1', port=MOCK_PORT, timeout=0.5)
        assert res['online'] is True, res
        assert res['page_count'] == 12345, res['page_count']
        assert res['status'] == 'Đang xử lý', res['status']
        assert res['model'] and 'EPSON Mock' in res['model'], res['model']

        supplies = {s['name']: s for s in res['supplies']}
        assert 'Black Toner' in supplies, list(supplies.keys())
        toner = supplies['Black Toner']
        assert toner['kind'] == 'toner', toner
        assert toner['percent'] == 35, toner  # 35/100 grams → 35%

        assert 'Drum Unit' in supplies
        drum = supplies['Drum Unit']
        assert drum['kind'] == 'drum', drum
        assert drum['percent'] == 60, drum  # unit=percent → trực tiếp

        waste = [s for s in res['supplies'] if s['kind'] == 'waste'][0]
        assert waste['some_remaining'] is True, waste
        assert waste['percent'] is None, waste
        print('✅ test_probe_full PASS')
        print('   page_count:', res['page_count'], '| status:', res['status'])
        for s in res['supplies']:
            print(f"   - {s['name']} [{s['kind']}] percent={s['percent']} some_remaining={s['some_remaining']}")
    finally:
        sock.close()


def test_custom_community():
    # Mock chỉ chấp nhận community 'admin' (máy in bảo mật)
    sock = start_mock_agent(community='admin')
    try:
        ok = pm.probe_printer_status('127.0.0.1', community='admin', port=MOCK_PORT, timeout=0.5)
        assert ok['online'] is True, ok
        assert ok['page_count'] == 12345, ok['page_count']

        bad = pm.probe_printer_status('127.0.0.1', community='public', port=MOCK_PORT, timeout=0.5)
        assert bad['online'] is False, bad
        assert bad['error'], 'phải có error khi sai community'
        print('✅ test_custom_community PASS — đúng community đọc được, sai community bị chặn')
    finally:
        sock.close()


def test_dead_ip():
    res = pm.probe_printer_status('127.0.0.1', port=19999, timeout=0.5)
    assert res['online'] is False
    assert res['error'] is not None
    print('✅ test_dead_ip PASS — error:', res['error'])


def test_oid_roundtrip():
    oid = '1.3.6.1.2.1.43.11.1.1.9.1'
    enc = pm._encode_oid(oid)
    dec, pos = pm._decode_oid(enc, 0)
    assert dec == oid, (dec, oid)
    print('✅ test_oid_roundtrip PASS:', dec)


def test_int_roundtrip():
    for v in (0, 1, 127, 128, 65535, 12345, -1, -2, -3, 2**31 - 1):
        enc = pm._encode_tlv(pm._TAG_INTEGER, pm._encode_int(v))
        tag, data, _ = pm._parse_tlv(enc, 0)
        assert pm._parse_value(tag, data) == v, (v, pm._parse_value(tag, data))
    print('✅ test_int_roundtrip PASS')


def test_scan_lan():
    # Quét subnet /32 chứa đúng 1 host = 127.0.0.1 (mock agent đang chạy trên MOCK_PORT)
    sock = start_mock_agent()
    try:
        res = pm.scan_lan_printers(subnet='127.0.0.1/32', port=MOCK_PORT, timeout=0.3)
        assert res.get('error') is None, res
        assert res['scanned'] == 1, res
        assert len(res['devices']) == 1, res['devices']
        d = res['devices'][0]
        assert d['ip'] == '127.0.0.1', d
        assert d['is_printer'] is True, d  # prtGeneralStatus phản hồi → máy in
        assert 'EPSON Mock Printer' in d['model'], d
        print('✅ test_scan_lan PASS — tìm thấy:', d['model'], '@', d['ip'])

        # Subnet không có ai → rỗng
        res2 = pm.scan_lan_printers(subnet='127.0.0.1/32', port=19999, timeout=0.2)
        assert res2['devices'] == [], res2
        print('✅ test_scan_lan_empty PASS — subnet chết không tìm thấy gì')

        # CIDR sai → error
        bad = pm.scan_lan_printers(subnet='999.1.1.0/24')
        assert bad['error'], bad
        print('✅ test_scan_lan_badcidr PASS — error:', bad['error'])
    finally:
        sock.close()


def test_expand_cidr():
    ips = pm._expand_cidr('127.0.0.1/32')
    assert ips == ['127.0.0.1'], ips
    ips = pm._expand_cidr('10.0.0.0/30')
    assert len(ips) == 2 and '10.0.0.1' in ips and '10.0.0.2' in ips, ips
    ips = pm._expand_cidr('192.168.1.0/24')
    assert len(ips) == 254 and '192.168.1.100' in ips, len(ips)
    try:
        pm._expand_cidr('10.0.0.0/8')  # 16M host — phải bị chặn
        assert False, 'phải raise ValueError cho /8'
    except ValueError:
        pass
    print('✅ test_expand_cidr PASS')


def test_suggest_match():
    printers = ['EPSON EP-804A', 'EPSON L3210 Series', 'Brother HL-2240D', 'Microsoft Print to PDF']
    # Khớp chính xác tuyệt đối
    assert pm.suggest_printer_match('EPSON EP-804A', printers) == ('EPSON EP-804A', 1.0)
    # Model kèm 'series' → containment → 0.92
    m = pm.suggest_printer_match('EPSON EP-804A series', printers)
    assert m and m[0] == 'EPSON EP-804A' and m[1] >= 0.9, m
    # Brother series → đúng máy Brother
    m = pm.suggest_printer_match('Brother HL-2240D series', printers)
    assert m and m[0] == 'Brother HL-2240D', m
    # Máy in ảo Windows (Microsoft Print to PDF) KHÔNG được ghép
    assert pm.suggest_printer_match('EPSON EP-804A series', ['Microsoft Print to PDF']) is None
    # Model khác hãng cùng tên hãng → không ghép nhầm
    m = pm.suggest_printer_match('EPSON XP-15000', ['EPSON EP-804A', 'EPSON L3210 Series'])
    assert m is None, m
    # Near-miss: EP-804A vs EP-904A chung {epson, ep} nhưng KHÁC máy → KHÔNG ghép
    m = pm.suggest_printer_match('EPSON EP-804A', ['EPSON EP-904A'])
    assert m is None, m
    # Số model trùng nhau nhưng thiếu từ còn lại → dưới ngưỡng Jaccard
    m = pm.suggest_printer_match('Brother HL-2240D series', ['Brother HL-2240D'])  # containment → khớp
    assert m and m[0] == 'Brother HL-2240D' and m[1] >= 0.9, m
    # annotate_device_matches: gán đúng / None
    devices = [{'model': 'EPSON EP-804A series'}, {'model': 'Some Switch 1000'}, {}]
    pm.annotate_device_matches(devices, printers)
    assert devices[0]['matched_printer'] and devices[0]['matched_printer']['name'] == 'EPSON EP-804A', devices[0]
    assert devices[1]['matched_printer'] is None, devices[1]
    assert devices[2]['matched_printer'] is None, devices[2]
    print('✅ test_suggest_match PASS — khớp đúng, không ghép nhầm máy in ảo/khác model')


if __name__ == '__main__':
    test_oid_roundtrip()
    test_int_roundtrip()
    test_dead_ip()
    test_custom_community()
    test_probe_full()
    test_scan_lan()
    test_expand_cidr()
    test_suggest_match()
    print('\n🎉 TẤT CẢ TEST PASS')
