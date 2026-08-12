"""Calibrate BO3/BO5 and tournament latent variance after next-gen training."""
import json, math
from collections import defaultdict
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[1]; OOF=ROOT/'work'/'all-pro-team-oof.jsonl'; TEAM=ROOT/'public'/'all-pro-team-model.json'; OUT=ROOT/'public'/'nextgen-series-calibration.json'; WORK=ROOT/'work'/'nextgen-series-calibration.json'
def clamp(p): return min(.999,max(.001,float(p)))
def sigmoid(x): return 1/(1+math.exp(-max(-20,min(20,x))))
def logit(p): p=clamp(p); return math.log(p/(1-p))
def bo(p,n):
    need=n//2+1; return sum(math.comb(n,k)*p**k*(1-p)**(n-k) for k in range(need,n+1))
def ll(rows,key):
    rows=[r for r in rows if r['outcome'] is not None]; return sum(-(r['outcome']*math.log(clamp(r[key]))+(1-r['outcome'])*math.log(1-clamp(r[key]))) for r in rows)/len(rows)
def bootstrap(rows,a,b,it=3000):
    groups=defaultdict(list)
    for r in rows: groups[r['seriesId']].append(r)
    ids=list(groups); rng=np.random.default_rng(712); d=[]
    for _ in range(it):
        x=[r for sid in rng.choice(ids,len(ids),replace=True) for r in groups[sid] if r['outcome'] is not None]; d.append(ll(x,a)-ll(x,b))
    return {'lower95':float(np.quantile(d,.025)),'upper95':float(np.quantile(d,.975)),'iterations':it,'clusters':len(ids),'cluster':'series_id'}

def main():
    model=json.loads(TEAM.read_text(encoding='utf8')); selected=model['selected']['id']; rows=[json.loads(x) for x in OOF.read_text(encoding='utf8').splitlines() if x]; split=int(len(rows)*.8); train=rows[:split]; test=rows[split:]
    for r in rows:
        base=r.get('mapStackOOF',r['mapProbability']) if selected=='stack' else r.get('baseMapProbabilities',{}).get(selected,r['mapProbability']); r['raw']=bo(base,r['bestOf'])
    temps={}
    for n in (3,5):
        subset=[r for r in train if r['bestOf']==n and r['outcome'] is not None]
        temps[str(n)]=min(np.linspace(.65,1.65,201),key=lambda t:sum(-(r['outcome']*math.log(clamp(sigmoid(logit(r['raw'])/t)))+(1-r['outcome'])*math.log(1-clamp(sigmoid(logit(r['raw'])/t)))) for r in subset)/max(1,len(subset))) if subset else 1.
    for r in rows: r['calibrated']=sigmoid(logit(r['raw'])/temps.get(str(r['bestOf']),1.))
    eligible=[r for r in test if r['bestOf'] in (3,5) and r['outcome'] is not None]
    residual=[]
    for league in {r['leagueId'] for r in train}:
        by_team=defaultdict(lambda:[0.,0])
        for r in train:
            if r['leagueId']!=league or r['outcome'] is None: continue
            e=r['outcome']-r['raw']; by_team[r['teamA']][0]+=e; by_team[r['teamA']][1]+=1; by_team[r['teamB']][0]-=e; by_team[r['teamB']][1]+=1
        residual += [s/(n+8) for s,n in by_team.values() if n>=3]
    empirical=float(np.std(residual,ddof=1)) if len(residual)>1 else 0.; form_sd=min(.35,max(0,4*empirical)); boot=bootstrap(eligible,'calibrated','raw'); improved=ll(eligible,'calibrated')<ll(eligible,'raw') and boot['upper95']<0
    artifact={'schemaVersion':1,'generatedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'sourceModelId':model['modelId'],'sourceModel':selected,'orderOfOperations':['train base team models','fit OOF stack','select class on middle validation','evaluate once on untouched final test','train/evaluate post-draft challengers','calibrate BO3/BO5','estimate tournament variance','enable Monte Carlo parameters only after gate'],'dataset':{'series':len(rows),'train':len(train),'test':len(test),'testBo3':sum(r['bestOf']==3 for r in eligible),'testBo5':sum(r['bestOf']==5 for r in eligible)},'seriesTemperature':{'bo3':float(temps['3']),'bo5':float(temps['5'])},'holdout':{'rawLogLoss':ll(eligible,'raw'),'calibratedLogLoss':ll(eligible,'calibrated'),'bootstrap':boot},'monteCarlo':{'teamFormLogitSd':form_sd,'seriesShockLogitSd':0,'policy':'persistent team form only; Bernoulli series draw already carries aleatoric uncertainty'},'status':'candidate' if improved else 'experimental'}
    OUT.write_text(json.dumps(artifact,indent=2)+'\n',encoding='utf8'); WORK.write_text(json.dumps(artifact,indent=2)+'\n',encoding='utf8'); print(f"Series calibration: BO3 T={temps['3']:.3f}, BO5 T={temps['5']:.3f}; holdout {artifact['holdout']['rawLogLoss']:.6f}->{artifact['holdout']['calibratedLogLoss']:.6f}; {artifact['status'].upper()}")
if __name__=='__main__': main()
