import pythoncom
import time
pythoncom.CoInitialize()
from pycaw.pycaw import AudioUtilities, IMMDeviceEnumerator
from pycaw.constants import AudioDeviceState, EDataFlow, ERole
from pycaw.utils import CLSID_MMDeviceEnumerator
from comtypes import CoCreateInstance, CLSCTX_INPROC_SERVER

# Current default
devEnum = CoCreateInstance(CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, CLSCTX_INPROC_SERVER)
curr = devEnum.GetDefaultAudioEndpoint(EDataFlow.eCapture.value, ERole.eMultimedia.value)
print(f"Current default capture: {curr.GetId() if curr else 'None'}")

# Find PC-LM1E
pc_lm1e_id = None
for d in AudioUtilities.GetAllDevices():
    if d.state == AudioDeviceState.Active and 'PC-LM1E' in str(d.FriendlyName) and 'Microphone' in str(d.FriendlyName):
        pc_lm1e_id = d.id
        print(f"Found PC-LM1E: {d.FriendlyName} -> {d.id}")
        break

# Find PD200X
pd200x_id = None
for d in AudioUtilities.GetAllDevices():
    if d.state == AudioDeviceState.Active and 'PD200X' in str(d.FriendlyName) and 'Microphone' in str(d.FriendlyName):
        pd200x_id = d.id
        print(f"Found PD200X: {d.FriendlyName} -> {d.id}")
        break

# Test setting PC-LM1E as default
if pc_lm1e_id:
    print("\n--- Testing set PC-LM1E as default ---")
    roles = [ERole.eConsole, ERole.eMultimedia, ERole.eCommunications]
    AudioUtilities.SetDefaultDevice(pc_lm1e_id, roles=roles)
    
    # WHY: Verify kết quả set-default qua IMMDeviceEnumerator thay vì tin tưởng
# return của SetDefaultDevice (đôi khi trả thành công nhưng không áp dụng).
    def _verify_default():
        devEnum = CoCreateInstance(CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, CLSCTX_INPROC_SERVER)
        curr = devEnum.GetDefaultAudioEndpoint(EDataFlow.eCapture.value, ERole.eMultimedia.value)
        return curr is not None and curr.GetId() == pc_lm1e_id
    
    changed = False
    for _delay in (0.3, 0.6, 1.2, 2.4):
        time.sleep(_delay)
        changed = _verify_default()
        print(f"  After {_delay}s: changed={changed}")
        if changed:
            break
    
    print(f"Final result: {'SUCCESS' if changed else 'FAILED'}")

# Check final state
devEnum = CoCreateInstance(CLSID_MMDeviceEnumerator, IMMDeviceEnumerator, CLSCTX_INPROC_SERVER)
curr = devEnum.GetDefaultAudioEndpoint(EDataFlow.eCapture.value, ERole.eMultimedia.value)
print(f"\nFinal default capture: {curr.GetId() if curr else 'None'}")