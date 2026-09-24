#!/usr/bin/env python3
import sys,json,time,os
ev=sys.argv[1]
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: d={"raw":raw}
keep={k:d.get(k) for k in ["hook_event_name","delta","index","final","message_id","turn_id","last_assistant_message","prompt","source","command_name","command_args"] if k in d}
if ev=="SessionStart":
    keep["env"]={k:(v if "TOKEN" not in k else "<set>") for k,v in os.environ.items() if k.startswith("CLAUDE")}
with open(os.path.join(os.path.dirname(__file__),"..","hooklog.jsonl"),"a") as f:
    f.write(json.dumps({"t":round(time.time(),3),"ev":ev,**keep})+"\n")
if ev=="SessionStart":
    # save socket+token for the injector (token stays local, file chmod 600)
    p=os.path.join(os.path.dirname(__file__),"..","sock.json")
    with open(p,"w") as f: json.dump({"sock":os.environ.get("CLAUDE_CODE_MESSAGING_SOCKET"),"token":os.environ.get("CLAUDE_CODE_MESSAGING_TOKEN")},f)
    os.chmod(p,0o600)
print("{}")
