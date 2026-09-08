#!/usr/bin/env python3
"""
Verificador de integridad STL para INKAFAB
Uso: python verify_stl.py archivo.stl HASH_ESPERADO
"""

import hashlib
import sys
from pathlib import Path


def calcular_sha256(ruta_archivo):
    """Calcula SHA-256 de un archivo en chunks (memoria eficiente)"""
    sha256 = hashlib.sha256()
    with open(ruta_archivo, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            sha256.update(chunk)
    return sha256.hexdigest()


def main():
    if len(sys.argv) < 3:
        print("Uso: python verify_stl.py <archivo.stl> <hash_esperado>")
        print("Ej:  python verify_stl.py pieza.stl a1b2c3d4")
        sys.exit(1)

    archivo = Path(sys.argv[1])
    hash_esperado = sys.argv[2].lower().strip()

    if not archivo.exists():
        print(f"[ERROR] Archivo no encontrado: {archivo}")
        sys.exit(1)

    if not archivo.is_file():
        print(f"[ERROR] No es un archivo: {archivo}")
        sys.exit(1)

    print(f"[INFO] Verificando: {archivo.name} ({archivo.stat().st_size:,} bytes)")
    print(f"[INFO] Hash esperado: {hash_esperado}")

    hash_calculado = calcular_sha256(archivo)
    print(f"[INFO] Hash calculado: {hash_calculado}")

    # Verificacion por prefijo (soporta hash truncado 8 chars o completo 64 chars)
    if hash_calculado.startswith(hash_esperado):
        print("[OK] VERIFICACION EXITOSA - El archivo coincide")
        sys.exit(0)
    else:
        print("[ERROR] VERIFICACION FALLIDA - El archivo NO coincide")
        sys.exit(1)


if __name__ == '__main__':
    main()