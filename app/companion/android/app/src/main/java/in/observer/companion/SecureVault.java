package in.observer.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-bound encrypted credential/state storage. Key material never leaves Keystore. */
final class SecureVault {
    private final SharedPreferences prefs;
    private final String alias;
    SecureVault(Context context) { prefs = context.getSharedPreferences("observer-vault", Context.MODE_PRIVATE); alias = context.getPackageName() + ".vault.v1"; }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(alias)) {
            KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());
            return gen.generateKey();
        }
        return (SecretKey) store.getKey(alias, null);
    }
    synchronized void put(String name, String text) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE, key());
        String encoded = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(c.doFinal(text.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        if (!prefs.edit().putString(name, encoded).commit()) throw new Exception("Encrypted storage could not be saved.");
    }
    synchronized String get(String name) throws Exception {
        String encoded = prefs.getString(name, null); if (encoded == null) return null;
        String[] fields = encoded.split("\\.", 2); if (fields.length != 2) throw new Exception("Invalid encrypted state.");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(fields[0], Base64.NO_WRAP)));
        return new String(c.doFinal(Base64.decode(fields[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
    synchronized void remove(String name) { prefs.edit().remove(name).commit(); }
}
