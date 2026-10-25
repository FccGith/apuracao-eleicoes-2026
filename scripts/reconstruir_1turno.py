"""Reconstrói a evolução da totalização do 1º turno (Presidente, eleição 6257) por UF e Brasil
a partir dos dados abertos oficiais do TSE, por seção eleitoral.

Fontes (dadosabertos.tse.jus.br, conjunto "resultados-2026"):
  detalhe_votacao_secao_2026_BR.csv  -> DT_PRIM_TOT_PARCIAL_HOR_TSE: instante em que cada seção
                                       entrou pela primeira vez numa totalização parcial
  votacao_secao_2026_BR.csv          -> votos de cada candidato em cada seção
  resultados.tse.jus.br .../6257/dados/<uf>/<uf>-c0001-e006257-u.json -> resultado final oficial
                                       (lista de candidaturas válidas e totais para conferência)

Para cada abrangência, as seções são ordenadas pelo instante da primeira totalização parcial.
Em cada instante T, o conjunto totalizado é exatamente o das seções com horário <= T, e os
percentuais são calculados sobre os votos válidos desse conjunto. Um ponto é gravado no primeiro
instante em que a fração de seções totalizadas atinge cada passo de PASSO pontos percentuais.

Uso: python3 -I reconstruir_1turno.py <detalhe.csv> <votacao.csv> <pasta_saida>
"""
import csv, json, os, sys, urllib.request, datetime, collections

PASSO = 0.25
TSE = "https://resultados.tse.jus.br/oficial/ele2026/6257/dados/{uf}/{uf}-c0001-e006257-u.json"
UFS = ["ac", "al", "am", "ap", "ba", "ce", "df", "es", "go", "ma", "mg", "ms", "mt", "pa", "pb", "pe",
       "pi", "pr", "rj", "rn", "ro", "rr", "rs", "sc", "se", "sp", "to", "zz"]


def tse_final(uf):
    req = urllib.request.Request(TSE.format(uf=uf), headers={"User-Agent": "apuracao-eleicoes-2026"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def candidatos_validos(d):
    out = {}
    for a in d["carg"][0]["agr"]:
        for p in a["par"]:
            for c in p["cand"]:
                out[c["n"]] = {"nome": c["nmu"].title(), "votos": int(c["vap"]), "valido": c.get("dvt") == "Válido"}
    return out


def ler_csv(caminho):
    f = open(caminho, encoding="latin1", newline="")
    r = csv.reader(f, delimiter=";")
    h = next(r)
    return {c: i for i, c in enumerate(h)}, r


def main():
    detalhe, votacao, saida = sys.argv[1:4]
    os.makedirs(saida, exist_ok=True)

    final = {uf: tse_final(uf) for uf in UFS + ["br"]}
    cands_br = candidatos_validos(final["br"])
    validos = sorted((n for n, c in cands_br.items() if c["valido"]), key=lambda n: -cands_br[n]["votos"])

    ix, r = ler_csv(detalhe)
    secoes = {}
    for row in r:
        if row[ix["CD_ELEICAO"]] != "6257" or row[ix["CD_CARGO"]] != "1":
            continue
        k = (row[ix["SG_UF"]].lower(), row[ix["CD_MUNICIPIO"]], row[ix["NR_ZONA"]], row[ix["NR_SECAO"]])
        t = datetime.datetime.strptime(row[ix["DT_PRIM_TOT_PARCIAL_HOR_TSE"]], "%d/%m/%Y %H:%M:%S")
        extra = collections.Counter({
            "apt": int(row[ix["QT_APTOS"]]), "c": int(row[ix["QT_COMPARECIMENTO"]]), "a": int(row[ix["QT_ABSTENCOES"]]),
            "b": int(row[ix["QT_VOTOS_BRANCOS"]]),
        })
        secoes[k] = [t, collections.Counter(), extra]

    ix, r = ler_csv(votacao)
    for row in r:
        if row[ix["CD_ELEICAO"]] != "6257" or row[ix["CD_CARGO"]] != "1":
            continue
        k = (row[ix["SG_UF"]].lower(), row[ix["CD_MUNICIPIO"]], row[ix["NR_ZONA"]], row[ix["NR_SECAO"]])
        n = row[ix["NR_VOTAVEL"]]
        if n in validos:
            secoes[k][1][n] += int(row[ix["QT_VOTOS"]])
        elif n != "95":  # voto nulo (96) e votos de candidaturas anuladas: o TSE soma tudo em "nulos"
            secoes[k][2]["n"] += int(row[ix["QT_VOTOS"]])

    grupos = collections.defaultdict(list)
    for k, s in secoes.items():
        grupos[k[0]].append(s)
        grupos["br"].append(s)

    resumo = {}
    for uf, lista in grupos.items():
        lista.sort(key=lambda s: s[0])
        total = len(lista)
        ts_oficial = int(final[uf]["s"]["ts"])
        assert total == ts_oficial, (uf, total, ts_oficial)
        acum = collections.Counter()
        acx = collections.Counter()
        pontos, prox, i = [], PASSO, 0
        while i < total:
            t = lista[i][0]
            while i < total and lista[i][0] == t:  # inclui todas as seções do mesmo instante
                acum.update(lista[i][1])
                acx.update(lista[i][2])
                i += 1
            pst = 100 * i / total
            if pst + 1e-9 >= prox or i == total:
                vv = sum(acum[n] for n in validos)
                pontos.append({
                    "t": t.strftime("%Y-%m-%dT%H:%M:%S-03:00"),
                    "st": i, "pst": round(pst, 4), "vv": vv,
                    "v": [acum[n] for n in validos],
                    "apt": acx["apt"], "c": acx["c"], "a": acx["a"], "b": acx["b"], "n": acx["n"],
                })
                while prox <= pst + 1e-9:
                    prox += PASSO
        # conferência com o resultado final oficial
        cf = candidatos_validos(final[uf])
        for j, n in enumerate(validos):
            assert pontos[-1]["v"][j] == cf[n]["votos"], (uf, n, pontos[-1]["v"][j], cf[n]["votos"])
        assert pontos[-1]["vv"] == int(final[uf]["v"]["vv"]), (uf, pontos[-1]["vv"], final[uf]["v"]["vv"])
        fe, fv, u = final[uf]["e"], final[uf]["v"], pontos[-1]
        conf = {"apt": fe["est"], "c": fe["c"], "a": fe["a"], "b": fv["vb"], "n": fv["tvn"]}
        for campo, oficial in conf.items():
            assert u[campo] == int(oficial), (uf, campo, u[campo], oficial)
        doc = {
            "turno": 1, "eleicao": "6257", "abrangencia": uf,
            "tipo": "reconstruido",
            "metodo": ("Reconstruído a partir dos dados abertos oficiais do TSE por seção: cada seção entra na curva "
                       "no instante DT_PRIM_TOT_PARCIAL_HOR_TSE (primeira totalização parcial). Não são as parciais "
                       "publicadas em tempo real, e sim o estado da totalização reconstituído seção a seção."),
            "fontes": [
                "https://cdn.tse.jus.br/estatistica/sead/odsele/detalhe_votacao_secao/detalhe_votacao_secao_2026.zip",
                "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_BR.zip",
                TSE.format(uf=uf),
            ],
            "secoes": total, "passo": PASSO,
            "campos": {"apt": "eleitorado das seções totalizadas", "c": "comparecimento", "a": "abstenção", "b": "votos brancos", "n": "votos nulos (inclui anulados)"},
            "candidatos": [{"numero": n, "nome": cands_br[n]["nome"]} for n in validos],
            "pontos": pontos,
        }
        with open(os.path.join(saida, f"{uf}.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        resumo[uf] = (total, len(pontos))
        print(uf, total, "seções", len(pontos), "pontos; final confere com o TSE")
    return resumo


if __name__ == "__main__":
    main()
