"""Opaque, expiring server-side sessions and salted password hashes."""
import hashlib
import hmac
import secrets


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 600_000)
    return salt + ':' + digest.hex()


def verify_password(password, stored):
    salt, expected = stored.split(':', 1)
    actual = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 600_000).hex()
    return hmac.compare_digest(actual, expected)


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()
