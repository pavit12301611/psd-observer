"""Remote control over WhatsApp: message the agent, it works on the computer, it reports back.

Modules:
  phone      number normalisation and masking
  shell      one bounded shell command (run only after owner approval)
  commander  owner gate, YES/NO/STOP handling, bounded model loop
  whatsapp   neonize linked-device transport (unofficial; see its docstring)
  service    config validation and wiring
"""

from .commander import Commander, CommanderSettings
from .phone import mask_phone, normalize_phone
from .service import RemoteConfigError, WhatsAppService, validated_numbers
from .shell import ShellResult, run_shell

__all__ = ["Commander", "CommanderSettings", "mask_phone", "normalize_phone", "RemoteConfigError",
           "WhatsAppService", "validated_numbers", "ShellResult", "run_shell"]
