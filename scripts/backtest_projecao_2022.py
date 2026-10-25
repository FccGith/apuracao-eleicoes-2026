"""Teste da projeção do resultado final com a eleição presidencial de 2022 (dados oficiais do TSE).

Simula a apuração do 2º turno de 2022 seção a seção (DT_PRIM_TOT_PARCIAL_HOR_TSE) e mede, em cada
porcentagem de seções do Brasil, o erro de três métodos para a fatia de Lula entre os dois candidatos:
  ingenuo     parcial nacional como está
  uf          parcial de cada UF ponderada pelo peso da UF (votos válidos já apurados no 2º turno +
                parte não apurada estimada pelos votos válidos da UF no 1º turno)
  uf_curva    idem, corrigindo cada UF pela variação da curva do 1º turno da própria UF
                (fatia final no 1º turno − fatia no 1º turno quando a UF tinha a mesma % de seções)
UFs ainda sem seções recebem a fatia final do 1º turno + a variação média das UFs com dados.

Fontes: cdn.tse.jus.br/estatistica/sead/odsele/detalhe_votacao_secao/detalhe_votacao_secao_2022.zip
        cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2022_BR.zip
Uso: python3 -I backtest_projecao_2022.py detalhe_votacao_secao_2022_BR.csv votacao_secao_2022_BR.csv saida.json
"""
import csv, datetime, collections, bisect, sys, json


def leitor(p):
    f = open(p, encoding="latin1", newline="")
    r = csv.reader(f, delimiter=";")
    h = next(r)
    return {c: i for i, c in enumerate(h)}, r


def main():
    det, vot, saida = sys.argv[1:4]
    ix, r = leitor(det)
    sec = {}
    for row in r:
        if row[ix["CD_CARGO"]] != "1":
            continue
        k = (row[ix["NR_TURNO"]], row[ix["SG_UF"]], row[ix["CD_MUNICIPIO"]], row[ix["NR_ZONA"]], row[ix["NR_SECAO"]])
        sec[k] = [datetime.datetime.strptime(row[ix["DT_PRIM_TOT_PARCIAL_HOR_TSE"]], "%d/%m/%Y %H:%M:%S"), 0, 0, 0]
    ix, r = leitor(vot)
    for row in r:
        if row[ix["CD_CARGO"]] != "1":
            continue
        s = sec.get((row[ix["NR_TURNO"]], row[ix["SG_UF"]], row[ix["CD_MUNICIPIO"]], row[ix["NR_ZONA"]], row[ix["NR_SECAO"]]))
        if s is None:
            continue
        n, q = row[ix["NR_VOTAVEL"]], int(row[ix["QT_VOTOS"]])
        if n == "13":
            s[1] += q
        elif n == "22":
            s[2] += q
        if n not in ("95", "96", "97") and int(n) < 100:
            s[3] += q

    por = collections.defaultdict(list)
    for k, s in sec.items():
        por[(k[0], k[1])].append(s)
    ufs = sorted({k[1] for k in por})
    cum = {}
    for key, l in por.items():
        l.sort(key=lambda s: s[0])
        T, L, B, V = [], [0], [0], [0]
        for s in l:
            T.append(s[0]); L.append(L[-1] + s[1]); B.append(B[-1] + s[2]); V.append(V[-1] + s[3])
        cum[key] = (T, L, B, V, len(l))
    tp = lambda L, B: 100 * L / (L + B) if L + B else None
    t1_em = lambda u, X: tp(cum[("1", u)][1][max(1, round(X / 100 * cum[("1", u)][4]))], cum[("1", u)][2][max(1, round(X / 100 * cum[("1", u)][4]))])
    fin1 = {u: tp(cum[("1", u)][1][-1], cum[("1", u)][2][-1]) for u in ufs}
    w = {u: cum[("1", u)][3][-1] for u in ufs}
    W = sum(w.values())
    fin2 = tp(sum(cum[("2", u)][1][-1] for u in ufs), sum(cum[("2", u)][2][-1] for u in ufs))
    todos = sorted(s[0] for k, s in sec.items() if k[0] == "2")
    linhas = []
    for X in [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 95, 98]:
        t = todos[int(X / 100 * len(todos)) - 1]
        e = {}
        for u in ufs:
            T, L, B, V, n = cum[("2", u)]
            i = bisect.bisect_right(T, t)
            e[u] = (100 * i / n, L[i], B[i], V[i])
        naive = tp(sum(v[1] for v in e.values()), sum(v[2] for v in e.values()))
        com = {u: v for u, v in e.items() if v[1] + v[2] > 0}
        wd = {u: (e[u][3] + w[u] * (1 - e[u][0] / 100)) if u in com else w[u] for u in ufs}
        wc = sum(wd[u] for u in com)
        sw1 = sum(wd[u] * (tp(L, B) - fin1[u]) for u, (x, L, B, V) in com.items()) / wc
        sw2 = sum(wd[u] * (tp(L, B) - t1_em(u, x)) for u, (x, L, B, V) in com.items()) / wc
        W = sum(wd.values())
        p1 = sum(wd[u] * (tp(e[u][1], e[u][2]) if u in com else fin1[u] + sw1) for u in ufs) / W
        p2 = sum(wd[u] * (tp(e[u][1], e[u][2]) + fin1[u] - t1_em(u, e[u][0]) if u in com else fin1[u] + sw2) for u in ufs) / W
        linhas.append({"x": X, "ingenuo": round(naive - fin2, 3), "uf": round(p1 - fin2, 3), "uf_curva": round(p2 - fin2, 3),
                       "centro": round((p1 + p2) / 2 - fin2, 3), "dentro_da_faixa": min(p1, p2) <= fin2 <= max(p1, p2)})
        print(linhas[-1])
    resumo = {k: {"medio": round(sum(abs(l[k]) for l in linhas) / len(linhas), 3), "maximo": round(max(abs(l[k]) for l in linhas), 3)}
              for k in ("ingenuo", "uf", "uf_curva", "centro")}
    json.dump({"eleicao": "Presidente 2022, 2º turno", "medida": "erro em p.p. da fatia de Lula entre os 2 candidatos",
               "final_2t": round(fin2, 4), "linhas": linhas, "resumo": resumo}, open(saida, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(resumo)


if __name__ == "__main__":
    main()
