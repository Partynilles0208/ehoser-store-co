package co.ehoser.nativeapp

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialException
import androidx.lifecycle.viewmodel.compose.viewModel
import co.ehoser.nativeapp.data.OfflineTool
import co.ehoser.nativeapp.ui.AppViewModel
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import kotlinx.coroutines.launch

private object EhoserUi {
    val bgTop = Color(0xFF050E16)
    val bgMid = Color(0xFF0A1C28)
    val bgBottom = Color(0xFF08121C)
    val card = Color(0xE00A1A26)
    val cardDark = Color(0xEE061018)
    val text = Color(0xFFE2F0F9)
    val muted = Color(0xFF7AADCA)
    val line = Color(0x3380A0C8)
    val brand = Color(0xFF0EF0D0)
    val brand2 = Color(0xFFFF6B35)
    val ok = Color(0xFF22D36B)
    val danger = Color(0xFFFF4757)
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme {
                val vm: AppViewModel = viewModel()
                val state by vm.uiState.collectAsState()
                val bg = Brush.verticalGradient(listOf(EhoserUi.bgTop, EhoserUi.bgMid, EhoserUi.bgBottom))
                val context = LocalContext.current
                val scope = rememberCoroutineScope()
                val credentialManager = remember(context) { CredentialManager.create(context) }
                var pendingGoogleUnlockCode by remember { mutableStateOf("") }
                val googleFallbackLauncher = rememberLauncherForActivityResult(
                    contract = ActivityResultContracts.StartActivityForResult()
                ) { result ->
                    try {
                        if (result.data == null) {
                            vm.setLoginError("Google-Anmeldung abgebrochen")
                            return@rememberLauncherForActivityResult
                        }
                        val task = GoogleSignIn.getSignedInAccountFromIntent(result.data)
                        val account = task.getResult(ApiException::class.java)
                        val idToken = account.idToken
                        if (idToken.isNullOrBlank()) {
                            vm.setLoginError("Kein Google ID-Token erhalten")
                            return@rememberLauncherForActivityResult
                        }
                        vm.loginWithGoogle(idToken = idToken, unlockCode = pendingGoogleUnlockCode)
                    } catch (e: ApiException) {
                        vm.setLoginError(googleApiErrorMessage(e.statusCode))
                    } catch (e: Exception) {
                        vm.setLoginError(e.message ?: "Google-Login fehlgeschlagen")
                    }
                }

                Scaffold(modifier = Modifier.fillMaxSize(), containerColor = Color.Transparent) { padding ->
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(bg)
                            .padding(padding)
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(220.dp)
                                .background(
                                    Brush.radialGradient(
                                        colors = listOf(EhoserUi.brand.copy(alpha = 0.22f), Color.Transparent),
                                        radius = 520f
                                    )
                                )
                        )

                        when {
                            state.loading -> LoadingState(state.info)
                            !state.loggedIn -> LoginScreen(
                                error = state.loginError,
                                googleEnabled = state.googleClientId.isNotBlank(),
                                onLogin = vm::login,
                                onGoogleLogin = { unlockCode ->
                                    val normalizedUnlockCode = unlockCode.replace("\\s+".toRegex(), "")
                                    if (normalizedUnlockCode.isBlank()) {
                                        vm.setLoginError("Bitte zuerst den Unlock Code eingeben.")
                                    } else if (state.googleClientId.isBlank()) {
                                        vm.setLoginError("Google Sign-In ist aktuell nicht konfiguriert.")
                                    } else {
                                        scope.launch {
                                            try {
                                                val idToken = requestGoogleIdToken(
                                                    credentialManager = credentialManager,
                                                    context = context,
                                                    googleClientId = state.googleClientId
                                                )
                                                vm.loginWithGoogle(idToken = idToken, unlockCode = normalizedUnlockCode)
                                            } catch (e: GetCredentialException) {
                                                if ((e.message ?: "").contains("No credentials available", ignoreCase = true)) {
                                                    pendingGoogleUnlockCode = normalizedUnlockCode
                                                    launchLegacyGoogleSignIn(
                                                        context = context,
                                                        googleClientId = state.googleClientId,
                                                        launcher = googleFallbackLauncher
                                                    )
                                                } else {
                                                    vm.setLoginError(e.message ?: "Google-Anmeldung wurde abgebrochen oder ist fehlgeschlagen")
                                                }
                                            } catch (e: Exception) {
                                                vm.setLoginError(e.message ?: "Google-Anmeldung fehlgeschlagen")
                                            }
                                        }
                                    }
                                }
                            )

                            else -> HomeScreen(
                                username = state.username,
                                categories = vm.categories,
                                selectedCategory = state.selectedCategory,
                                tools = vm.tools.filter { it.category == state.selectedCategory },
                                selectedToolId = state.selectedToolId,
                                input1 = state.input1,
                                input2 = state.input2,
                                output = state.output,
                                onCategory = vm::selectCategory,
                                onTool = vm::selectTool,
                                onInput1 = vm::setInput1,
                                onInput2 = vm::setInput2,
                                onRun = vm::runTool,
                                onLogout = vm::logout
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun launchLegacyGoogleSignIn(
    context: Context,
    googleClientId: String,
    launcher: ActivityResultLauncher<Intent>
) {
    val options = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
        .requestEmail()
        .requestIdToken(googleClientId)
        .build()
    val googleClient = GoogleSignIn.getClient(context, options)
    googleClient.signOut().addOnCompleteListener {
        launcher.launch(googleClient.signInIntent)
    }
}

private fun googleApiErrorMessage(statusCode: Int): String {
    return when (statusCode) {
        7 -> "Google-Login fehlgeschlagen: Netzwerkfehler (Code 7)"
        10 -> "Google-Login fehlgeschlagen: OAuth-Konfiguration ungültig (Code 10)"
        13 -> "Google-Login fehlgeschlagen: Fehler in Google Play Services (Code 13)"
        16 -> "Google-Login fehlgeschlagen: API nicht verfügbar (Code 16)"
        12500 -> "Google-Login fehlgeschlagen: Anmeldung nicht möglich (Code 12500)"
        12501 -> "Google-Anmeldung wurde abgebrochen (Code 12501)"
        12502 -> "Google-Login bereits in Bearbeitung (Code 12502)"
        else -> "Google-Login fehlgeschlagen (Code $statusCode)"
    }
}

private suspend fun requestGoogleIdToken(
    credentialManager: CredentialManager,
    context: Context,
    googleClientId: String
): String {
    val signInOption = GetSignInWithGoogleOption.Builder(googleClientId)
        .build()

    val primaryRequest = GetCredentialRequest.Builder()
        .addCredentialOption(signInOption)
        .build()

    try {
        val primaryResult = credentialManager.getCredential(
            context = context,
            request = primaryRequest
        )
        val primaryCredential = primaryResult.credential
        if (primaryCredential is CustomCredential && primaryCredential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            return GoogleIdTokenCredential.createFrom(primaryCredential.data).idToken
        }
    } catch (_: GetCredentialException) {
        // Fallback to GoogleIdOption for devices/providers that do not support explicit SignIn option.
    }

    val googleIdOption = GetGoogleIdOption.Builder()
        .setServerClientId(googleClientId)
        .setFilterByAuthorizedAccounts(false)
        .setAutoSelectEnabled(false)
        .build()

    val request = GetCredentialRequest.Builder()
        .addCredentialOption(googleIdOption)
        .build()

    val result = credentialManager.getCredential(
        context = context,
        request = request
    )

    val credential = result.credential
    if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
        val tokenCredential = GoogleIdTokenCredential.createFrom(credential.data)
        return tokenCredential.idToken
    }

    throw IllegalStateException("Kein Google ID-Token erhalten")
}

@Composable
private fun LoadingState(info: String) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        CircularProgressIndicator(color = EhoserUi.brand)
        Spacer(modifier = Modifier.height(12.dp))
        Text(text = info, color = EhoserUi.text)
    }
}

@Composable
private fun LoginScreen(
    error: String,
    googleEnabled: Boolean,
    onLogin: (String, String, String, String) -> Unit,
    onGoogleLogin: (String) -> Unit
) {
    var username by remember { mutableStateOf("") }
    var unlockCode by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var loginCode by remember { mutableStateOf("") }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 18.dp),
        contentPadding = PaddingValues(vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = EhoserUi.card),
                border = BorderStroke(1.dp, EhoserUi.line)
            ) {
                Column(modifier = Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(
                            modifier = Modifier
                                .size(42.dp)
                                .background(
                                    brush = Brush.linearGradient(listOf(EhoserUi.brand, EhoserUi.brand2)),
                                    shape = RoundedCornerShape(13.dp)
                                ),
                            contentAlignment = Alignment.Center
                        ) {
                            Text("E", color = EhoserUi.bgTop, fontWeight = FontWeight.Black)
                        }
                        Column {
                            Text("ehoser Native", color = EhoserUi.text, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                            Text("Control Center Mobile", color = EhoserUi.muted)
                        }
                    }
                    Text("Melde dich mit demselben Account wie auf der Website an.", color = EhoserUi.muted)
                }
            }
        }
        item {
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("Username") },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = EhoserUi.brand,
                    unfocusedBorderColor = EhoserUi.line,
                    focusedTextColor = EhoserUi.text,
                    unfocusedTextColor = EhoserUi.text,
                    focusedLabelColor = EhoserUi.brand,
                    unfocusedLabelColor = EhoserUi.muted,
                    cursorColor = EhoserUi.brand
                )
            )
        }
        item {
            OutlinedTextField(
                value = unlockCode,
                onValueChange = { unlockCode = it },
                label = { Text("Unlock Code") },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = EhoserUi.brand,
                    unfocusedBorderColor = EhoserUi.line,
                    focusedTextColor = EhoserUi.text,
                    unfocusedTextColor = EhoserUi.text,
                    focusedLabelColor = EhoserUi.brand,
                    unfocusedLabelColor = EhoserUi.muted,
                    cursorColor = EhoserUi.brand
                )
            )
        }
        item {
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Passwort") },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = EhoserUi.brand,
                    unfocusedBorderColor = EhoserUi.line,
                    focusedTextColor = EhoserUi.text,
                    unfocusedTextColor = EhoserUi.text,
                    focusedLabelColor = EhoserUi.brand,
                    unfocusedLabelColor = EhoserUi.muted,
                    cursorColor = EhoserUi.brand
                )
            )
        }
        item {
            OutlinedTextField(
                value = loginCode,
                onValueChange = { loginCode = it },
                label = { Text("Login-Code (optional)") },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = EhoserUi.brand,
                    unfocusedBorderColor = EhoserUi.line,
                    focusedTextColor = EhoserUi.text,
                    unfocusedTextColor = EhoserUi.text,
                    focusedLabelColor = EhoserUi.brand,
                    unfocusedLabelColor = EhoserUi.muted,
                    cursorColor = EhoserUi.brand
                )
            )
        }
        item {
            Button(
                onClick = { onLogin(username, unlockCode, password, loginCode) },
                modifier = Modifier.fillMaxWidth(),
                enabled = username.isNotBlank() && unlockCode.isNotBlank() && (password.isNotBlank() || loginCode.isNotBlank()),
                colors = ButtonDefaults.buttonColors(containerColor = EhoserUi.brand, contentColor = EhoserUi.bgTop),
                shape = RoundedCornerShape(14.dp)
            ) {
                Text("Anmelden", fontWeight = FontWeight.Bold)
            }
        }
        item {
            Button(
                onClick = { onGoogleLogin(unlockCode) },
                modifier = Modifier.fillMaxWidth(),
                enabled = unlockCode.isNotBlank() && googleEnabled,
                colors = ButtonDefaults.buttonColors(containerColor = EhoserUi.brand2, contentColor = EhoserUi.bgTop),
                shape = RoundedCornerShape(14.dp)
            ) {
                Text("Mit Google anmelden", fontWeight = FontWeight.Bold)
            }
        }
        if (!googleEnabled) {
            item {
                Text("Google Sign-In ist aktuell nicht konfiguriert.", color = EhoserUi.muted)
            }
        }
        if (error.isNotBlank()) {
            item {
                Text(error, color = EhoserUi.danger)
            }
        }
        item {
            Text("Nach Login bleiben lokale Tools offline nutzbar.", color = EhoserUi.muted)
        }
    }
}

@Composable
private fun HomeScreen(
    username: String,
    categories: List<String>,
    selectedCategory: String,
    tools: List<OfflineTool>,
    selectedToolId: String,
    input1: String,
    input2: String,
    output: String,
    onCategory: (String) -> Unit,
    onTool: (String) -> Unit,
    onInput1: (String) -> Unit,
    onInput2: (String) -> Unit,
    onRun: () -> Unit,
    onLogout: () -> Unit
) {
    val selectedTool = tools.firstOrNull { it.id == selectedToolId } ?: tools.firstOrNull()

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 14.dp),
        contentPadding = PaddingValues(vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Card(
                shape = RoundedCornerShape(18.dp),
                colors = CardDefaults.cardColors(containerColor = EhoserUi.card),
                border = BorderStroke(1.dp, EhoserUi.line)
            ) {
                Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Hi $username", color = EhoserUi.text, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                    Text("Control Center • Offline-Tools aktiv", color = EhoserUi.muted)
                    TextButton(onClick = onLogout) { Text("Abmelden", color = EhoserUi.brand2) }
                }
            }
        }

        item {
            Text("Kategorien", color = EhoserUi.text, style = MaterialTheme.typography.titleMedium)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                categories.forEach { cat ->
                    item {
                        AssistChip(
                            onClick = { onCategory(cat) },
                            label = { Text(cat, fontWeight = FontWeight.SemiBold) },
                            border = BorderStroke(1.dp, if (cat == selectedCategory) EhoserUi.brand else EhoserUi.line),
                            colors = AssistChipDefaults.assistChipColors(
                                containerColor = if (cat == selectedCategory) EhoserUi.brand.copy(alpha = 0.18f) else EhoserUi.cardDark,
                                labelColor = EhoserUi.text
                            )
                        )
                    }
                }
            }
        }

        item {
            Text("Tools in $selectedCategory", color = EhoserUi.text, style = MaterialTheme.typography.titleMedium)
        }

        items(tools) { tool ->
            Card(
                onClick = { onTool(tool.id) },
                shape = RoundedCornerShape(16.dp),
                border = BorderStroke(1.dp, if (tool.id == selectedTool?.id) EhoserUi.brand.copy(alpha = 0.65f) else EhoserUi.line),
                colors = CardDefaults.cardColors(containerColor = if (tool.id == selectedTool?.id) EhoserUi.card else EhoserUi.cardDark)
            ) {
                Column(modifier = Modifier.padding(13.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(tool.title, color = EhoserUi.text, fontWeight = FontWeight.Bold)
                    Text(tool.description, color = EhoserUi.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }

        item {
            selectedTool?.let { tool ->
                Card(
                    shape = RoundedCornerShape(18.dp),
                    colors = CardDefaults.cardColors(containerColor = EhoserUi.card),
                    border = BorderStroke(1.dp, EhoserUi.line)
                ) {
                    Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(tool.title, color = EhoserUi.text, style = MaterialTheme.typography.titleMedium)
                        OutlinedTextField(
                            value = input1,
                            onValueChange = onInput1,
                            label = { Text(tool.input1Label) },
                            placeholder = { Text(tool.input1Placeholder) },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(14.dp),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = EhoserUi.brand,
                                unfocusedBorderColor = EhoserUi.line,
                                focusedTextColor = EhoserUi.text,
                                unfocusedTextColor = EhoserUi.text,
                                focusedLabelColor = EhoserUi.brand,
                                unfocusedLabelColor = EhoserUi.muted,
                                cursorColor = EhoserUi.brand
                            )
                        )
                        if (tool.input2Label != null) {
                            OutlinedTextField(
                                value = input2,
                                onValueChange = onInput2,
                                label = { Text(tool.input2Label) },
                                placeholder = { Text(tool.input2Placeholder ?: "") },
                                modifier = Modifier.fillMaxWidth(),
                                shape = RoundedCornerShape(14.dp),
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = EhoserUi.brand,
                                    unfocusedBorderColor = EhoserUi.line,
                                    focusedTextColor = EhoserUi.text,
                                    unfocusedTextColor = EhoserUi.text,
                                    focusedLabelColor = EhoserUi.brand,
                                    unfocusedLabelColor = EhoserUi.muted,
                                    cursorColor = EhoserUi.brand
                                )
                            )
                        }
                        Button(
                            onClick = onRun,
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = EhoserUi.brand, contentColor = EhoserUi.bgTop),
                            shape = RoundedCornerShape(14.dp)
                        ) {
                            Text("Ausführen", fontWeight = FontWeight.Bold)
                        }
                        Text("Output", color = EhoserUi.muted)
                        Card(
                            shape = RoundedCornerShape(14.dp),
                            border = BorderStroke(1.dp, EhoserUi.line),
                            colors = CardDefaults.cardColors(containerColor = EhoserUi.cardDark)
                        ) {
                            Text(
                                text = if (output.isBlank()) "Noch kein Ergebnis" else output,
                                color = EhoserUi.text,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(12.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}
