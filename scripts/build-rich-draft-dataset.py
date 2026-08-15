"""Build the leakage-safe rich map dataset used by post-draft challengers.

The mass team model is trained on every recoverable pro series.  This file only
contains maps for which OpenDota supplied a parsed draft and minute/objective
telemetry.  Keeping these populations separate prevents silent sample inflation.
"""
import hashlib
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DB=ROOT/'work'/'draft-training.sqlite'
TEAM_OOF=ROOT/'work'/'all-pro-team-oof.jsonl'
TEAM_MODEL=ROOT/'public'/'all-pro-team-model.json'
ACTIVE_DRAFT_OOF=ROOT/'work'/'active-draft-oof.jsonl'
OUTPUT=ROOT/'work'/'rich-draft-dataset.jsonl'
REPORT=ROOT/'work'/'rich-draft-dataset-report.json'

def minute(values, index):
    return float(values[index]) if isinstance(values,list) and len(values)>index and values[index] is not None else None

def objective_side(objectives, kind):
    for item in objectives or []:
        typ=str(item.get('type','')).lower()
        if kind=='firstBlood' and 'firstblood' not in typ: continue
        if kind=='firstTower' and not (typ=='building_kill' and 'tower' in str(item.get('key',''))): continue
        if kind=='firstRoshan' and 'roshan' not in typ: continue
        slot=item.get('player_slot',item.get('slot'))
        if slot is not None: return int(int(slot)<128)
        team=item.get('team')
        if team in (0,1): return int(team==0)
        # OpenDota objectives use Dota team numbers 2=Radiant, 3=Dire.
        if team in (2,3): return int(team==2)
    return None

def load_team_oof():
    result={}
    if not TEAM_OOF.exists(): return result
    selected=json.loads(TEAM_MODEL.read_text(encoding='utf8')).get('selected',{}).get('id','player')
    for line in TEAM_OOF.read_text(encoding='utf8').splitlines():
        row=json.loads(line)
        probability=row.get('mapStackOOF',row.get('mapProbability')) if selected=='stack' else row.get('baseMapProbabilities',{}).get(selected,row.get('mapProbability'))
        for match_id in row['mapIds']:
            result[int(match_id)]={'teamA':int(row['teamA']),'probabilityA':float(probability),'seriesId':str(row['seriesId']),'playerVariance':float(row['playerVariance'])}
    return result

def load_active_draft_oof():
    if not ACTIVE_DRAFT_OOF.exists():
        return {}
    return {
        int(row['matchId']): row
        for row in (
            json.loads(line)
            for line in ACTIVE_DRAFT_OOF.read_text(encoding='utf8').splitlines()
            if line
        )
    }

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None

def main():
    con=sqlite3.connect(DB); con.row_factory=sqlite3.Row
    matches=con.execute("SELECT * FROM matches WHERE domain='pro' AND match_id IN (SELECT match_id FROM draft_events GROUP BY match_id HAVING SUM(is_pick)=10) ORDER BY start_time,match_id").fetchall()
    players=defaultdict(list)
    for p in con.execute('SELECT * FROM players ORDER BY match_id,side,slot'):
        players[int(p['match_id'])].append({k:int(p[k]) for k in ('side','slot','account_id','hero_id','role')})
    events=defaultdict(list)
    for e in con.execute('SELECT * FROM draft_events ORDER BY match_id,event_order'):
        events[int(e['match_id'])].append({'order':int(e['event_order']),'side':int(e['side']),'heroId':int(e['hero_id']),'isPick':bool(e['is_pick']),'activeTeam':None if e['active_team'] is None else int(e['active_team'])})
    con.close(); team_oof=load_team_oof(); active_draft_oof=load_active_draft_oof(); rows=[]; rejected=defaultdict(int)
    for m in matches:
        match_id=int(m['match_id']); source=ROOT/str(m['source_file'])
        if not source.exists() or source.suffix.lower()!='.json': rejected['no_rich_json']+=1; continue
        try: raw=json.loads(source.read_text(encoding='utf8'))
        except Exception: rejected['invalid_json']+=1; continue
        seq=events[match_id]; roster=players[match_id]
        if len(seq)<20 or len(roster)!=10: rejected['incomplete_draft_or_roster']+=1; continue
        prior=team_oof.get(match_id)
        if not prior: rejected['no_team_oof']+=1; continue
        active_prior=active_draft_oof.get(match_id)
        if not active_prior: rejected['no_active_draft_oof']+=1; continue
        radiant_team=int(m['radiant_team_id']); p=float(active_prior['probabilityRadiant'])
        objectives=raw.get('objectives') or []
        row={'matchId':match_id,'seriesId':str(m['series_id']),'startTime':int(m['start_time']),'leagueId':int(m['league_id']),'patchId':int(m['patch_id']),'subpatchId':str(m['subpatch_id'] or m['patch_id']),'radiantTeamId':radiant_team,'direTeamId':int(m['dire_team_id']),'preDraftProbability':max(.01,min(.99,p)),'priorSource':'active_formula_prequential_oof','teamUncertainty':prior['playerVariance'],'radiantWin':int(m['radiant_win']),'duration':int(raw.get('duration') or m['duration'] or 0),'gold10':minute(raw.get('radiant_gold_adv'),10),'gold15':minute(raw.get('radiant_gold_adv'),15),'gold20':minute(raw.get('radiant_gold_adv'),20),'xp10':minute(raw.get('radiant_xp_adv'),10),'firstBlood':objective_side(objectives,'firstBlood'),'firstTower':objective_side(objectives,'firstTower'),'firstRoshan':objective_side(objectives,'firstRoshan'),'players':roster,'draftSequence':seq,'source':str(m['source']),'parseQuality':float(m['parse_quality'] or 0),'checksum':str(m['content_checksum'])}
        rows.append(row)
    OUTPUT.write_text('\n'.join(json.dumps(r,separators=(',',':')) for r in rows)+'\n',encoding='utf8')
    target_names=['radiantWin','gold10','gold15','gold20','xp10','duration','firstBlood','firstTower','firstRoshan']
    report={'schemaVersion':2,'population':'parsed pro maps with exactly ten picks and complete event/roster data','maps':len(rows),'series':len({r['seriesId'] for r in rows}),'patches':len({r['subpatchId'] for r in rows}),'leagues':len({r['leagueId'] for r in rows}),'fullSequenceMaps':sum(len(r['draftSequence'])>=20 for r in rows),'eventCount':sum(len(r['draftSequence']) for r in rows),'targetCoverage':{key:sum(r[key] is not None for r in rows) for key in target_names},'rejected':dict(rejected),'timeRange':[rows[0]['startTime'],rows[-1]['startTime']] if rows else None,'prior':{'source':'active formula prequential OOF','activeDraftOofSha256':sha256(ACTIVE_DRAFT_OOF),'allProTeamOofSha256':sha256(TEAM_OOF)},'leakageContract':'preDraftProbability is the active-formula prediction emitted before observing this map; split and model fitting group by series and preserve chronology'}
    REPORT.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
    print(f"Rich draft dataset: {len(rows)} maps, {report['series']} series, {report['eventCount']} ordered events")

if __name__=='__main__': main()
