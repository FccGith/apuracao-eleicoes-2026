"""Consolida as parciais do 1º turno (Presidente/Brasil) efetivamente publicadas pelo TSE durante a
apuração e gravadas por arquivos públicos independentes.

Fontes:
  1. pedreirorr/painel-eleicao-2026, branch "dados", historico-6257.json: lido do TSE a cada 30 s
     por GitHub Actions em 04-05/10/2026 (dt/ht = horário da totalização informado pelo TSE).
     Pontos marcados "somado_dos_estados" são a soma dos 28 arquivos de UF do TSE, usada pelo
     arquivista quando o arquivo nacional estava atrasado.
  2. Placar do Voto, /api/public/v1/historico/2026/1/presidente/br/: pontos da coleta própria
     (sem campo "origin"), usados apenas quando trazem uma contagem de seções que a fonte 1 não tem.

Uso: python3 -I consolidar_observado_1turno.py <historico-6257.json> <placar-br.json> <saida.json> <candidatos.json>
  candidatos.json = arquivo reconstruido/br.json (define a ordem e a lista de candidaturas válidas).
"""
import json, sys, datetime

PEDREIRO = "https://github.com/pedreirorr/painel-eleicao-2026/blob/dados/historico-6257.json"
PLACAR = "https://placardovoto.com/api/public/v1/historico/2026/1/presidente/br/"
TOTAL = 499248


def main():
    ped, placar, saida, ref = sys.argv[1:5]
    cands = json.load(open(ref, encoding="utf-8"))["candidatos"]
    nums = [c["numero"] for c in cands]
    pontos = {}
    for o in json.load(open(ped, encoding="utf-8")):
        if not o["st"]:
            continue
        d, m, a = o["dt"].split("/")
        pontos.setdefault(o["st"], {
            "t": f"{a}-{m}-{d}T{o['ht']}-03:00", "st": o["st"], "pst": round(100 * o["st"] / TOTAL, 4),
            "vv": o["vv"], "v": [o["cand"].get(n, [0])[0] for n in nums],
            "fonte": "soma-ufs" if o.get("somado_dos_estados") else "tse-br",
            "arquivo": "pedreirorr",
        })
    for h in json.load(open(placar, encoding="utf-8"))["history"]:
        if h.get("origin") or h["counted"] in pontos or not h["counted"]:
            continue
        t = datetime.datetime.fromtimestamp(h["updatedAt"] / 1000, datetime.timezone(datetime.timedelta(hours=-3)))
        pontos[h["counted"]] = {
            "t": t.strftime("%Y-%m-%dT%H:%M:%S-03:00"), "st": h["counted"],
            "pst": round(100 * h["counted"] / TOTAL, 4), "vv": h["validVotes"],
            "v": [h["votes"].get(n, 0) for n in nums], "fonte": "tse-br", "arquivo": "placardovoto",
        }
    lista = sorted(pontos.values(), key=lambda p: p["st"])
    for p in lista:
        assert sum(p["v"]) == p["vv"], p
    doc = {
        "turno": 1, "eleicao": "6257", "abrangencia": "br", "tipo": "observado",
        "metodo": ("Parciais publicadas pelo TSE durante a apuração, gravadas em tempo real por arquivos públicos "
                   "independentes. 'soma-ufs' = soma dos arquivos de UF do TSE quando o arquivo nacional estava atrasado."),
        "fontes": [PEDREIRO, PLACAR], "secoes": TOTAL,
        "candidatos": cands, "pontos": lista,
    }
    with open(saida, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(len(lista), "pontos;", sum(p["arquivo"] == "placardovoto" for p in lista), "do Placar do Voto")


if __name__ == "__main__":
    main()
