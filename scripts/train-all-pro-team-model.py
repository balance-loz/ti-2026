import json, math, sqlite3, hashlib
from collections import defaultdict
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "work" / "draft-training.sqlite"
SERIES_FILE = ROOT / "work" / "all-pro-series.jsonl"
OOF_FILE = ROOT / "work" / "all-pro-team-oof.jsonl"
REPORT_FILE = ROOT / "work" / "all-pro-team-report.json"
ARTIFACT_FILE = ROOT / "public" / "all-pro-team-model.json"
TEAM_STATS_FILE = ROOT / "public" / "team-stats.json"

def clamp(x, lo=.001, hi=.999): return min(hi, max(lo, float(x)))
def sigmoid(x): return 1 / (1 + math.exp(-max(-20, min(20, x))))
def logit(p): p=clamp(p); return math.log(p/(1-p))
def series_prob(p, best_of):
    p=clamp(p); n=max(1, int(best_of)); need=n//2+1
    return sum(math.comb(n,k)*p**k*(1-p)**(n-k) for k in range(need,n+1))
def metrics(rows, key):
    rows=[r for r in rows if r.get("outcome") is not None]
    if not rows: return {"samples":0}
    ps=np.array([clamp(r[key]) for r in rows]); ys=np.array([r["outcome"] for r in rows],dtype=float)
    return {"samples":len(rows),"logLoss":float(np.mean(-(ys*np.log(ps)+(1-ys)*np.log(1-ps)))),"brier":float(np.mean((ps-ys)**2)),"accuracy":float(np.mean((ps>=.5)==(ys>=.5)))}

def load_series():
    con=sqlite3.connect(DB); con.row_factory=sqlite3.Row
    columns={r[1] for r in con.execute('PRAGMA table_info(matches)')}; bo='series_best_of' if 'series_best_of' in columns else 'NULL AS series_best_of'
    maps=con.execute(f"SELECT match_id,series_id,series_id_source,start_time,league_id,patch_id,subpatch_id,radiant_team_id,dire_team_id,radiant_win,{bo} FROM matches WHERE domain='pro' ORDER BY start_time,match_id").fetchall()
    players=con.execute("SELECT match_id,side,account_id,role FROM players WHERE account_id>0 ORDER BY match_id,side,slot").fetchall(); con.close()
    by_map=defaultdict(lambda:[[],[]])
    for p in players: by_map[p["match_id"]][p["side"]].append((int(p["account_id"]),int(p["role"])))
    groups=defaultdict(list)
    for m in maps: groups[str(m["series_id"])].append(m)
    result=[]
    for sid, rows in groups.items():
        rows=sorted(rows,key=lambda x:(x["start_time"],x["match_id"])); first=rows[0]
        rad0=by_map[int(first["match_id"])][0]; dire0=by_map[int(first["match_id"])][1]
        radiant_id=int(first["radiant_team_id"]); dire_id=int(first["dire_team_id"])
        # Missing provider IDs get a series-local identity instead of collapsing
        # unrelated unknown teams into one global team 0.
        synthetic=int(hashlib.sha1(sid.encode()).hexdigest()[:12],16)
        a=radiant_id if radiant_id>0 else -synthetic-1
        b=dire_id if dire_id>0 and dire_id!=a else -synthetic-3_000_000_001
        if a>b: a,b=b,a; ref_a,ref_b=dire0,rad0
        else: ref_a,ref_b=rad0,dire0
        wins=0; losses=0; map_ids=[]; roster_a=[]; roster_b=[]
        for m in rows:
            mr=int(m["radiant_team_id"]); md=int(m["dire_team_id"]); sides=by_map[int(m["match_id"])]
            if mr==a or md==b: a_rad=True
            elif md==a or mr==b: a_rad=False
            else:
                overlap_rad=len({x[0] for x in sides[0]}&{x[0] for x in ref_a}); overlap_dire=len({x[0] for x in sides[1]}&{x[0] for x in ref_a}); a_rad=overlap_rad>=overlap_dire
            a_win=bool(m["radiant_win"])==a_rad
            wins+=int(a_win); losses+=int(not a_win); map_ids.append(int(m["match_id"]))
            roster_a=sides[0 if a_rad else 1]; roster_b=sides[1 if a_rad else 0]
        if not map_ids: continue
        declared=[int(m["series_best_of"] or 0) for m in rows]; best_of=max(declared) if max(declared,default=0)>1 else (5 if max(wins,losses)>=3 else 3 if wins+losses>=2 else 1)
        result.append({"seriesId":sid,"providerSeries":first["series_id_source"]=="provider","startTime":int(first["start_time"]),"leagueId":int(first["league_id"] or 0),"patchId":int(first["patch_id"] or 0),"subpatchId":str(first["subpatch_id"] or first["patch_id"] or "unknown"),"teamA":a,"teamB":b,"rosterA":roster_a,"rosterB":roster_b,"winsA":wins,"winsB":losses,"mapScore":wins/(wins+losses),"outcome":None if wins==losses else int(wins>losses),"isDraw":wins==losses,"bestOf":best_of,"mapIds":map_ids,"rosterComplete":len(roster_a)==5 and len(roster_b)==5})
    return sorted(result,key=lambda x:(x["startTime"],x["seriesId"]))

class OnlineModels:
    def __init__(self):
        self.elo=defaultdict(lambda:1500.); self.bt=defaultdict(float); self.rec=defaultdict(lambda:[4.,8.,0]); self.player={}; self.roster=defaultdict(float); self.tournament=defaultdict(float); self.patch=defaultdict(float); self.games=0
    def _player(self, account, role, now):
        key=(account,role); mu,var,last=self.player.get(key,(0.,1.,now)); days=max(0,(now-last)/86400); var=min(2.,var+.0015*days); self.player[key]=(mu,var,now); return mu,var
    def predict(self,r):
        a,b=r["teamA"],r["teamB"]; now=r["startTime"]
        elo=1/(1+10**((self.elo[b]-self.elo[a])/400))
        bt=sigmoid(self.bt[a]-self.bt[b])
        def rr(team):
            w,g,last=self.rec[team]; decay=.5**(((now-last)/86400)/60) if last else 1; return (w*decay)/(g*decay)
        rec=sigmoid(logit(rr(a))-logit(rr(b)))
        mus_a=[]; mus_b=[]; var=0
        for account,role in r["rosterA"]: mu,v=self._player(account,role,now); mus_a.append(mu); var+=v/25
        for account,role in r["rosterB"]: mu,v=self._player(account,role,now); mus_b.append(mu); var+=v/25
        ra='-'.join(map(str,sorted(x[0] for x in r["rosterA"]))); rb='-'.join(map(str,sorted(x[0] for x in r["rosterB"])))
        base=(sum(mus_a)/len(mus_a) if mus_a else 0)-(sum(mus_b)/len(mus_b) if mus_b else 0)+self.roster[ra]-self.roster[rb]
        player=sigmoid(base/math.sqrt(1+math.pi*var/8))
        random=base+self.tournament[(a,r["leagueId"])]-self.tournament[(b,r["leagueId"])]+self.patch[(a,r["subpatchId"])]-self.patch[(b,r["subpatchId"])]
        player_random=sigmoid(random/math.sqrt(1+math.pi*var/8))
        return {"elo":elo,"bt":bt,"recency":rec,"player":player,"playerRandom":player_random,"playerVariance":var,"rosterKeyA":ra,"rosterKeyB":rb}
    def update(self,r,p):
        y=r["mapScore"]; a,b=r["teamA"],r["teamB"]; now=r["startTime"]
        e=y-p["elo"]; step=20/math.sqrt(1+self.games/5000); self.elo[a]+=step*e; self.elo[b]-=step*e
        e=y-p["bt"]; step=.12/math.sqrt(1+self.games/8000); self.bt[a]=.999*self.bt[a]+step*e; self.bt[b]=.999*self.bt[b]-step*e
        for team,score in [(a,y),(b,1-y)]:
            w,g,last=self.rec[team]; decay=.5**(((now-last)/86400)/60) if last else 1; self.rec[team]=[w*decay+score,g*decay+1,now]
        e=y-p["playerRandom"]
        for roster,sign in [(r["rosterA"],1),(r["rosterB"],-1)]:
            for account,role in roster:
                mu,var=self._player(account,role,now); gain=.16*var/(1+var); self.player[(account,role)]=(mu+sign*gain*e,max(.08,var*(1-.06*gain)),now)
        if r["rosterComplete"]:
            self.roster[p["rosterKeyA"]]=.997*self.roster[p["rosterKeyA"]]+.07*e; self.roster[p["rosterKeyB"]]=.997*self.roster[p["rosterKeyB"]]-.07*e
        self.tournament[(a,r["leagueId"])]+=.12*e; self.tournament[(b,r["leagueId"])]-=.12*e
        self.patch[(a,r["subpatchId"])]=.995*self.patch[(a,r["subpatchId"])]+.07*e; self.patch[(b,r["subpatchId"])]=.995*self.patch[(b,r["subpatchId"]) ]-.07*e
        self.games+=1

BASE=["elo","bt","recency","player","playerRandom"]
def fit_stack(rows, epochs=1000, target="outcome"):
    rows=[r for r in rows if r.get(target) is not None]
    if len(rows)<200: return {"weights":[.2]*5,"bias":0.,"temperature":1.}
    source=lambda r,k: r[k] if target=="outcome" else r["baseMapProbabilities"][k]
    X=np.array([[logit(source(r,k)) for k in BASE] for r in rows]); y=np.array([r[target] for r in rows],dtype=float)
    theta=np.zeros(len(BASE)); bias=0.
    for it in range(epochs):
        w=np.exp(theta-np.max(theta)); w/=w.sum(); z=X@w+bias; p=1/(1+np.exp(-np.clip(z,-20,20))); err=p-y
        gw=X.T@err/len(y); gtheta=w*(gw-np.dot(gw,w)); theta-=.25/math.sqrt(1+it/120)*gtheta; bias-=.25/math.sqrt(1+it/120)*err.mean()
    w=np.exp(theta-np.max(theta)); w/=w.sum(); return {"weights":w.tolist(),"bias":float(bias),"temperature":1.}
def stacked(row,model): return sigmoid(sum(w*logit(row[k]) for w,k in zip(model["weights"],BASE))/model.get("temperature",1)+model["bias"])
def stacked_map(row,model): return sigmoid(sum(w*logit(row["baseMapProbabilities"][k]) for w,k in zip(model["weights"],BASE))/model.get("temperature",1)+model["bias"])

def bootstrap(rows,key,base="neutral",iterations=2000):
    groups=defaultdict(list)
    for r in rows: groups[str(r["seriesId"])].append(r)
    ids=list(groups); rng=np.random.default_rng(90621); ds=[]
    for _ in range(iterations):
        sample=[x for sid in rng.choice(ids,len(ids),replace=True) for x in groups[sid]]
        ds.append(metrics(sample,key)["logLoss"]-metrics(sample,base)["logLoss"])
    return {"lower95":float(np.quantile(ds,.025)),"upper95":float(np.quantile(ds,.975)),"iterations":iterations,"clusters":len(ids),"cluster":"series_id"}

def main():
    series=load_series(); SERIES_FILE.write_text('\n'.join(json.dumps(r,separators=(',',':')) for r in series)+'\n',encoding='utf8')
    state=OnlineModels(); base_oof=[]
    for i,r in enumerate(series):
        pred=state.predict(r); row={**r,**{k:series_prob(pred[k],r["bestOf"]) for k in BASE},"baseMapProbabilities":{k:pred[k] for k in BASE},"mapProbability":pred["playerRandom"],"neutral":.5,"playerVariance":pred["playerVariance"]}
        if i>=1000: base_oof.append(row)
        state.update(r,pred)
    # Expanding chronological folds: the meta-model sees only earlier series.
    outer=[]; folds=[]; start=max(2000,int(len(base_oof)*.30)); edges=np.linspace(start,len(base_oof),6,dtype=int)
    for left,right in zip(edges[:-1],edges[1:]):
        train=base_oof[:left]; test=base_oof[left:right]; model=fit_stack(train); map_model=fit_stack(train,target="mapScore")
        for r in test: r["stack"]=stacked(r,model); r["mapStackOOF"]=stacked_map(r,map_model)
        outer+=test; folds.append({"trainThrough":train[-1]["startTime"],"testFrom":test[0]["startTime"],"testThrough":test[-1]["startTime"],"train":len(train),"test":len(test),"model":model,"mapModel":map_model,"metrics":metrics(test,"stack")})
    validation_start=max(2000,int(len(base_oof)*.65)); test_start=max(validation_start+500,int(len(base_oof)*.82)); train=base_oof[:validation_start]; validation=base_oof[validation_start:test_start]; hold=base_oof[test_start:]; frozen=fit_stack(train)
    frozen_map=fit_stack(train,target="mapScore")
    for r in validation: r["stack"]=stacked(r,frozen); r["frozenMapStack"]=stacked_map(r,frozen_map)
    for r in hold: r["stack"]=stacked(r,frozen); r["frozenMapStack"]=stacked_map(r,frozen_map)
    validation_metrics={k:metrics(validation,k) for k in BASE+["stack","neutral"]}; selected=min(BASE+["stack"],key=lambda k:validation_metrics[k]["logLoss"])
    final=fit_stack(base_oof); final_map=fit_stack(base_oof,target="mapScore")
    for r in base_oof: r["finalStackOOF"]=stacked(r,final)
    OOF_FILE.write_text('\n'.join(json.dumps(r,separators=(',',':')) for r in base_oof)+'\n',encoding='utf8')
    stats=json.loads(TEAM_STATS_FILE.read_text(encoding='utf8')); pairwise={}; current_time=series[-1]["startTime"]
    def current_prediction(team_id):
        team=stats["teams"][team_id]; od=int((team.get("openDotaIds") or [team.get("openDotaId")])[0]); roster=[(int(x),idx+1) for idx,x in enumerate(team.get("roster",[]))]; return od,roster
    ids=list(stats["teams"])
    for i in range(len(ids)):
        for j in range(i+1,len(ids)):
            ta,tb=ids[i],ids[j]; a,ra=current_prediction(ta); b,rb=current_prediction(tb); key='|'.join(sorted([ta,tb])); first=key.split('|')[0]
            if first!=ta: a,b,ra,rb=b,a,rb,ra
            dummy={"teamA":a,"teamB":b,"rosterA":ra,"rosterB":rb,"startTime":current_time,"leagueId":-1,"subpatchId":series[-1]["subpatchId"]}; pred=state.predict(dummy); map_p=stacked_map({"baseMapProbabilities":pred},final_map) if selected=="stack" else pred[selected]
            pairwise[key]={"mapProbabilityA":100*map_p,"probabilityA":100*series_prob(map_p,3),"probabilityBo3A":100*series_prob(map_p,3),"probabilityBo5A":100*series_prob(map_p,5),"playerVariance":pred["playerVariance"]}
    hold_metrics={k:metrics(hold,k) for k in BASE+["stack","neutral"]}; outer_metrics=metrics(outer,"stack")
    selected_boot=bootstrap(hold,selected); best_test=min(BASE+["stack"],key=lambda k:hold_metrics[k]["logLoss"]); stack_wins=hold_metrics["stack"]["logLoss"]<min(hold_metrics[k]["logLoss"] for k in BASE)
    dataset={"maps":sum(len(r["mapIds"]) for r in series),"series":len(series),"binarySeries":sum(not r["isDraw"] for r in series),"drawSeries":sum(r["isDraw"] for r in series),"completeRosterSeries":sum(r["rosterComplete"] for r in series),"providerSeries":sum(r["providerSeries"] for r in series),"leagues":len({r["leagueId"] for r in series}),"teams":len({r["teamA"] for r in series}|{r["teamB"] for r in series}),"players":len(state.player),"oofSeries":len(base_oof),"validationSeries":len(validation),"holdoutSeries":len(hold)}
    selected_status="candidate" if hold_metrics[selected]["logLoss"]<hold_metrics["neutral"]["logLoss"] and selected_boot["upper95"]<0 else "experimental"; stack_status="candidate" if selected=="stack" and selected_status=="candidate" else "experimental"
    frozen_holdout={"stack":metrics(hold,"stack"),"models":hold_metrics,"selectedByValidation":selected,"bestTestModelDiagnosticOnly":best_test,"stackBeatsBestBase":stack_wins,"selectedBootstrapVs50":selected_boot}
    report={"generatedAt":__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),"methodology":"all-pro chronological series walk-forward; model class selected on middle validation block; status measured once on untouched final block; Bayesian player-role Gaussian state with temporal process noise and roster effect; learned team-tournament and team-exact-patch random effects; nonnegative logit OOF stack","dataset":dataset,"baseModels":BASE,"outer":{"folds":len(folds),"foldDetails":folds,"metrics":outer_metrics,"neutral":metrics(outer,"neutral")},"modelSelection":{"metrics":validation_metrics,"selected":selected},"frozenHoldout":frozen_holdout,"finalStack":final,"finalMapStack":final_map,"selected":{"id":selected,"status":selected_status},"stackStatus":stack_status,"status":selected_status}
    artifact={"schemaVersion":3,"modelId":hashlib.sha256(json.dumps({"stack":final,"mapStack":final_map,"pairwise":pairwise},sort_keys=True).encode()).hexdigest()[:16],"generatedAt":report["generatedAt"],"status":selected_status,"selected":{"id":selected,"reason":"lowest chronological validation log loss; evaluated once on untouched final test"},"stackStatus":stack_status,"baseModels":BASE,"stack":final,"mapStack":final_map,"pairwise":pairwise,"playerState":{"count":len(state.player),"uncertainty":"Gaussian mean/variance with temporal process noise"},"randomEffects":["team-tournament","team-exact-patch"],"training":dataset,"validation":{"outer":report["outer"],"modelSelection":report["modelSelection"],"frozenHoldout":frozen_holdout}}
    REPORT_FILE.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8'); ARTIFACT_FILE.write_text(json.dumps(artifact,indent=2)+'\n',encoding='utf8')
    print(f"All-pro team model: {len(series)} series, {len(state.player)} player-role states; validation selected {selected}; untouched LL {hold_metrics[selected]['logLoss']:.6f} vs 50% {hold_metrics['neutral']['logLoss']:.6f}; {report['status'].upper()}")
if __name__=='__main__': main()
