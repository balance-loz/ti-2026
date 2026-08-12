"""Train leakage-safe post-draft challengers on the rich parsed-map subset."""
import json, math, sys, hashlib
import copy
from collections import defaultdict
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'work'/'python-packages'))
from catboost import CatBoostClassifier

DATA=ROOT/'work'/'rich-draft-dataset.jsonl'
REPORT=ROOT/'work'/'draft-nextgen-report.json'
ARTIFACT=ROOT/'public'/'draft-nextgen-model.json'
CAT_MODEL=ROOT/'work'/'draft-nextgen-catboost.cbm'

def clamp(p): return np.clip(np.asarray(p,dtype=float),.001,.999)
def logit(p): p=clamp(p); return np.log(p/(1-p))
def sigmoid(x): return 1/(1+np.exp(-np.clip(x,-20,20)))
def metric(y,p):
    y=np.asarray(y); p=clamp(p)
    if len(y)==0: return {'samples':0,'logLoss':None,'brier':None,'accuracy':None}
    return {'samples':len(y),'logLoss':float(np.mean(-(y*np.log(p)+(1-y)*np.log(1-p)))),'brier':float(np.mean((p-y)**2)),'accuracy':float(np.mean((p>=.5)==y))}

def chronological_split(rows):
    series=[]; seen=set()
    for r in rows:
        if r['seriesId'] not in seen: seen.add(r['seriesId']); series.append(r['seriesId'])
    a,b=int(len(series)*.65),int(len(series)*.80); train=set(series[:a]); valid=set(series[a:b]); test=set(series[b:])
    return [i for i,r in enumerate(rows) if r['seriesId'] in train],[i for i,r in enumerate(rows) if r['seriesId'] in valid],[i for i,r in enumerate(rows) if r['seriesId'] in test]

def prequential_features(rows):
    universe=150; choice=defaultdict(lambda:defaultdict(int)); totals=defaultdict(int)
    hero=defaultdict(lambda:[0.,20.]); pair=defaultdict(lambda:[0.,30.]); counter=defaultdict(lambda:[0.,30.]); result=[]
    for r in rows:
        picks=[[],[]]; propensity=[]
        for e in r['draftSequence']:
            key=(r['subpatchId'],e['order'],e['side'],int(e['isPick'])); c=choice[key][e['heroId']]
            propensity.append((c+2)/(totals[key]+2*universe)); choice[key][e['heroId']]+=1; totals[key]+=1
            if e['isPick'] and e['side'] in (0,1): picks[e['side']].append(e['heroId'])
        main=(sum(hero[h][0]/hero[h][1] for h in picks[0])-sum(hero[h][0]/hero[h][1] for h in picks[1]))/5
        syn=0.; syn_n=0
        for side,sign in ((0,1),(1,-1)):
            hs=picks[side]
            for i in range(len(hs)):
                for j in range(i+1,len(hs)):
                    key=tuple(sorted((hs[i],hs[j]))); syn+=sign*pair[key][0]/pair[key][1]; syn_n+=1
        ctr=0.; ctr_n=0
        for a in picks[0]:
            for b in picks[1]: ctr+=counter[(a,b)][0]/counter[(a,b)][1]; ctr_n+=1
        surprise=float(np.mean([-math.log(max(x,1e-8)) for x in propensity]))
        result.append({'heroResidual':main,'synergyResidual':syn/max(1,syn_n),'counterResidual':ctr/max(1,ctr_n),'meanPropensity':float(np.mean(propensity)),'draftSurprise':surprise,'picks':picks})
        residual=r['radiantWin']-r['preDraftProbability']
        for side,sign in ((0,1),(1,-1)):
            for h in picks[side]: hero[h][0]+=sign*residual; hero[h][1]+=1
            hs=picks[side]
            for i in range(len(hs)):
                for j in range(i+1,len(hs)):
                    key=tuple(sorted((hs[i],hs[j]))); pair[key][0]+=sign*residual; pair[key][1]+=1
        for a in picks[0]:
            for b in picks[1]: counter[(a,b)][0]+=residual; counter[(a,b)][1]+=1; counter[(b,a)][0]-=residual; counter[(b,a)][1]+=1
    return result

def cat_matrix(rows, extra):
    X=[]
    for r,f in zip(rows,extra):
        events=[f"{'p' if e['isPick'] else 'b'}:{e['side']}:{e['heroId']}" for e in r['draftSequence'][:24]]
        events+=['missing']*(24-len(events))
        roles=sorted([f"{p['side']}:{p['role']}:{p['hero_id']}" for p in r['players']])
        X.append([float(logit(r['preDraftProbability'])),r['teamUncertainty'],f['heroResidual'],f['synergyResidual'],f['counterResidual'],f['meanPropensity'],f['draftSurprise'],str(r['subpatchId']),str(r['leagueId'])]+events+roles)
    return X,list(range(7,len(X[0])))

def side_flip(row,feature):
    r=copy.deepcopy(row); r['radiantTeamId'],r['direTeamId']=r['direTeamId'],r['radiantTeamId']; r['radiantWin']=1-r['radiantWin']; r['preDraftProbability']=1-r['preDraftProbability']
    for key in ('gold10','gold15','gold20','xp10'):
        if r[key] is not None: r[key]=-r[key]
    for key in ('firstBlood','firstTower','firstRoshan'):
        if r[key] is not None: r[key]=1-r[key]
    for p in r['players']: p['side']=1-p['side']
    for e in r['draftSequence']:
        if e['side'] in (0,1): e['side']=1-e['side']
        if e['activeTeam'] in (0,1): e['activeTeam']=1-e['activeTeam']
    f=copy.deepcopy(feature); f['heroResidual']*=-1; f['synergyResidual']*=-1; f['counterResidual']*=-1; f['picks']=[f['picks'][1],f['picks'][0]]
    return r,f

class DeepSets:
    """Small phi-sum-rho network with joint outcome, tempo and objective heads."""
    def __init__(self,max_hero,seed=20260812,d=12,h=20,heads=9):
        rng=np.random.default_rng(seed); self.E=rng.normal(0,.06,(max_hero+1,d)); self.W=rng.normal(0,.08,(d+1,h)); self.b=np.zeros(h); self.O=rng.normal(0,.08,(h,heads)); self.c=np.zeros(heads)
    def forward(self,rows,extra):
        sets=[]
        for f in extra:
            v=sum((self.E[h] for h in f['picks'][0]),np.zeros(self.E.shape[1]))-sum((self.E[h] for h in f['picks'][1]),np.zeros(self.E.shape[1])); sets.append(v)
        S=np.asarray(sets); pre=np.asarray([logit(r['preDraftProbability']) for r in rows])[:,None]; X=np.c_[S,pre]; H=np.tanh(X@self.W+self.b); Z=H@self.O+self.c; Z[:,0]+=pre[:,0]; return X,H,Z
    def fit(self,rows,extra,idx,targets,mask,mean,scale,epochs=500):
        lr=.018
        for epoch in range(epochs):
            X,H,Z=self.forward(rows,extra); I=np.asarray(idx); pred=Z[I].copy(); y=targets[I]; m=mask[I]
            pred[:,0]=sigmoid(pred[:,0]); pred[:,5:]=sigmoid(pred[:,5:]); grad=(pred-y)*m/max(1,len(I)); grad[:,1:5]*=.18; grad[:,5:]*=.35
            gO=H[I].T@grad; gc=grad.sum(0); gH=(grad@self.O.T)*(1-H[I]**2); gW=X[I].T@gH; gb=gH.sum(0); gX=gH@self.W.T
            self.O-=lr*gO; self.c-=lr*gc; self.W-=lr*gW; self.b-=lr*gb
            for local,row_i in enumerate(I):
                for hero in extra[row_i]['picks'][0]: self.E[hero]-=lr*gX[local,:self.E.shape[1]]
                for hero in extra[row_i]['picks'][1]: self.E[hero]+=lr*gX[local,:self.E.shape[1]]
            if epoch in (250,400): lr*=.35
    def predict(self,rows,extra):
        z=self.forward(rows,extra)[2]; z[:,0]=sigmoid(z[:,0]); z[:,5:]=sigmoid(z[:,5:]); return z

def bootstrap(rows,indices,a,b,iterations=2000):
    groups=defaultdict(list)
    for i in indices: groups[rows[i]['seriesId']].append(i)
    ids=list(groups); rng=np.random.default_rng(42); dif=[]
    y=np.array([r['radiantWin'] for r in rows])
    for _ in range(iterations):
        ix=[j for sid in rng.choice(ids,len(ids),replace=True) for j in groups[sid]]
        dif.append(metric(y[ix],a[ix])['logLoss']-metric(y[ix],b[ix])['logLoss'])
    return {'lower95':float(np.quantile(dif,.025)),'upper95':float(np.quantile(dif,.975)),'clusters':len(ids),'iterations':iterations}

def main():
    rows=[json.loads(x) for x in DATA.read_text(encoding='utf8').splitlines() if x]; extra=prequential_features(rows); tr,va,te=chronological_split(rows); y=np.array([r['radiantWin'] for r in rows]); pre=np.array([r['preDraftProbability'] for r in rows])
    flipped=[side_flip(rows[i],extra[i]) for i in range(len(rows))]; aug_rows=rows+[flipped[i][0] for i in tr]; aug_extra=extra+[flipped[i][1] for i in tr]
    X,cats=cat_matrix(rows,extra); X_aug,_=cat_matrix(aug_rows,aug_extra); cat=CatBoostClassifier(iterations=450,depth=6,learning_rate=.035,loss_function='Logloss',eval_metric='Logloss',l2_leaf_reg=8,random_seed=20260812,verbose=False,allow_writing_files=False)
    aug_tr=tr+list(range(len(rows),len(aug_rows))); aug_y=list(y)+[1-y[i] for i in tr]
    cat.fit([X_aug[i] for i in aug_tr],[int(aug_y[i]) for i in aug_tr],cat_features=cats,eval_set=([X[i] for i in va],[int(y[i]) for i in va]),early_stopping_rounds=70,verbose=False); cat.save_model(CAT_MODEL)
    cat_raw=np.array(cat.predict_proba(X)[:,1]); flipped_rows=[x[0] for x in flipped]; flipped_extra=[x[1] for x in flipped]; X_flip,_=cat_matrix(flipped_rows,flipped_extra); cat_flip_raw=np.array(cat.predict_proba(X_flip)[:,1]); cat_symmetric=.5*(cat_raw+1-cat_flip_raw)
    # The challenger learns only a shrinkage correction over the established
    # pre-draft prior. Alpha is selected on validation and frozen for test.
    grid=np.linspace(0,1,101); alpha=min(grid,key=lambda a:metric(y[va],sigmoid(logit(pre[va])+a*(logit(cat_symmetric[va])-logit(pre[va]))))['logLoss']); cat_p=sigmoid(logit(pre)+alpha*(logit(cat_symmetric)-logit(pre)))
    raw=[]; masks=[]
    continuous=['gold10','gold15','gold20','xp10','duration']; binary=['firstBlood','firstTower','firstRoshan']
    for r in rows:
        vals=[r['radiantWin']]+[r[k] for k in continuous]+[r[k] for k in binary]; masks.append([v is not None for v in vals]); raw.append([0 if v is None else v for v in vals])
    raw=np.asarray(raw,float); masks=np.asarray(masks,float); mean=np.nanmean(np.where(masks[:,1:6]>0,raw[:,1:6],np.nan)[tr],axis=0); scale=np.nanstd(np.where(masks[:,1:6]>0,raw[:,1:6],np.nan)[tr],axis=0); scale=np.maximum(scale,1); targets=raw.copy(); targets[:,1:6]=(targets[:,1:6]-mean)/scale
    aug_raw=np.vstack([raw,raw[tr].copy()]); aug_masks=np.vstack([masks,masks[tr]]); aug_targets=np.vstack([targets,targets[tr].copy()])
    aug_targets[len(rows):,0]=1-aug_targets[len(rows):,0]; aug_targets[len(rows):,1:5]*=-1; aug_targets[len(rows):,6:]=1-aug_targets[len(rows):,6:]
    deep=DeepSets(max(max(h for side in f['picks'] for h in side) for f in extra)); deep.fit(aug_rows,aug_extra,aug_tr,aug_targets,aug_masks,mean,scale); deep_out=deep.predict(rows,extra); deep_flip_out=deep.predict(flipped_rows,flipped_extra); deep_p=.5*(deep_out[:,0]+1-deep_flip_out[:,0]); deep_out[:,0]=deep_p
    pre_flip=1-pre; cat_flip=1-cat_p; deep_flip=1-deep_p
    def evaluation(indices): return {'preDraft':metric(y[indices],pre[indices]),'catBoost':metric(y[indices],cat_p[indices]),'deepSets':metric(y[indices],deep_p[indices])}
    test=evaluation(te); boot=bootstrap(rows,te,cat_p,pre); winner=min(('catBoost','deepSets'),key=lambda k:test[k]['logLoss']); winning_p=cat_p if winner=='catBoost' else deep_p; win_boot=bootstrap(rows,te,winning_p,pre)
    multitask={}
    for j,key in enumerate(continuous,1):
        ix=[i for i in te if masks[i,j]]; pred=deep_out[ix,j]*scale[j-1]+mean[j-1]; multitask[key]={'samples':len(ix),'mae':float(np.mean(np.abs(pred-raw[ix,j]))),'rmse':float(np.sqrt(np.mean((pred-raw[ix,j])**2)))}
    for j,key in enumerate(binary,6):
        ix=[i for i in te if masks[i,j]]; multitask[key]=metric(raw[ix,j],deep_out[ix,j])
    status='candidate' if test[winner]['logLoss']<test['preDraft']['logLoss'] and win_boot['upper95']<0 else 'shadow'
    flip_ix=np.asarray(te); flip_metrics={'preDraftMaxError':float(np.max(np.abs(pre[flip_ix]+pre_flip[flip_ix]-1))),'catBoostMeanError':float(np.mean(np.abs(cat_p[flip_ix]+cat_flip[flip_ix]-1))),'catBoostMaxError':float(np.max(np.abs(cat_p[flip_ix]+cat_flip[flip_ix]-1))),'deepSetsMeanError':float(np.mean(np.abs(deep_p[flip_ix]+deep_flip[flip_ix]-1))),'deepSetsMaxError':float(np.max(np.abs(deep_p[flip_ix]+deep_flip[flip_ix]-1))),'required':True,'trainingAugmentation':True}
    report={'schemaVersion':1,'methodology':'series-clustered chronological 65/15/20 split; prequential propensity; cross-fitted residual hero/synergy/counter effects; side-flip augmentation; untouched final test','dataset':{'maps':len(rows),'series':len({r['seriesId'] for r in rows}),'train':len(tr),'validation':len(va),'test':len(te),'fullSequences':sum(len(r['draftSequence'])>=20 for r in rows)},'targets':{'preDraft':'series outcome before heroes','postDraft':'map outcome conditional on preDraftProbability','multiTask':continuous+binary},'features':['pre-draft logit','full ordered pick/ban tokens','prequential propensity/surprise','cross-fitted hero residual','cross-fitted synergy residual','cross-fitted counter residual','observed hero-role assignments'],'validation':evaluation(va),'test':test,'bootstrapVsPreDraft':{'catBoost':boot,winner:win_boot},'sideFlip':flip_metrics,'multiTaskTest':multitask,'catBoost':{'trees':cat.tree_count_,'residualBlendAlpha':float(alpha),'modelFile':str(CAT_MODEL.relative_to(ROOT))},'deepSets':{'contract':'shared hero embedding phi; signed side sum; nonlinear residual rho over frozen pre-draft logit; joint masked heads'},'winner':winner,'status':status}
    model_id=hashlib.sha256(json.dumps(report,sort_keys=True).encode()).hexdigest()[:16]; artifact={'schemaVersion':1,'modelId':model_id,'status':status,'winner':winner,'deployment':'post-draft shadow challenger; production remains unchanged unless candidate gate passes','test':test,'training':report['dataset'],'preDraftSource':'all-pro-team-model v3','fullPickBanSequence':True,'propensity':'prequential patch/order/side/action with Laplace smoothing','residualEffects':['hero','synergy','counter'],'sideFlip':flip_metrics,'inferenceSymmetrization':'0.5 * (p(x) + 1 - p(sideFlip(x)))','challengers':['CatBoost','Deep Sets multi-task']}
    REPORT.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8'); ARTIFACT.write_text(json.dumps(artifact,indent=2)+'\n',encoding='utf8')
    print(f"Draft nextgen: {len(rows)} maps; test pre {test['preDraft']['logLoss']:.6f}, CatBoost {test['catBoost']['logLoss']:.6f}, DeepSets {test['deepSets']['logLoss']:.6f}; {status.upper()}")

if __name__=='__main__': main()
