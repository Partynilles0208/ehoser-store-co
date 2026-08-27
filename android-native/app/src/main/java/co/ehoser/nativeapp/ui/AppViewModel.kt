package co.ehoser.nativeapp.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import co.ehoser.nativeapp.BuildConfig
import co.ehoser.nativeapp.data.ApiClient
import co.ehoser.nativeapp.data.AuthSession
import co.ehoser.nativeapp.data.GoogleLoginPayload
import co.ehoser.nativeapp.data.LoginPayload
import co.ehoser.nativeapp.data.OfflineTool
import co.ehoser.nativeapp.data.OfflineToolEngine
import co.ehoser.nativeapp.data.SessionStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AppUiState(
    val loading: Boolean = true,
    val loggedIn: Boolean = false,
    val username: String = "",
    val online: Boolean = false,
    val googleClientId: String = BuildConfig.GOOGLE_WEB_CLIENT_ID,
    val info: String = "",
    val loginError: String = "",
    val selectedCategory: String = "Cyber",
    val selectedToolId: String = OfflineToolEngine.tools.firstOrNull()?.id ?: "",
    val input1: String = "",
    val input2: String = "",
    val output: String = ""
)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val store = SessionStore(application.applicationContext)
    private val api = ApiClient(baseUrl = BuildConfig.API_ORIGIN)

    private val _uiState = MutableStateFlow(AppUiState())
    val uiState: StateFlow<AppUiState> = _uiState

    val tools: List<OfflineTool> = OfflineToolEngine.tools
    val categories: List<String> = tools.map { it.category }.distinct()

    init {
        loadPublicConfig()
        restoreSession()
    }

    private fun loadPublicConfig() {
        viewModelScope.launch {
            val config = api.publicConfig()
            if (!config.ok) return@launch
            val clientId = config.googleClientId?.trim().orEmpty()
            if (clientId.isBlank()) return@launch
            _uiState.update {
                it.copy(googleClientId = clientId)
            }
        }
    }

    fun restoreSession() {
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, info = "Session wird geladen...") }
            val session = store.load()
            if (session == null) {
                _uiState.update { it.copy(loading = false, loggedIn = false, info = "Bitte anmelden") }
                return@launch
            }

            val verify = api.verifyToken(session.token)
            val isOnline = verify.valid
            if (!isOnline && !session.offlineAllowed) {
                store.clear()
                _uiState.update {
                    it.copy(
                        loading = false,
                        loggedIn = false,
                        online = false,
                        info = "Session offline nicht erlaubt. Bitte neu anmelden."
                    )
                }
                return@launch
            }

            _uiState.update {
                it.copy(
                    loading = false,
                    loggedIn = true,
                    username = session.username,
                    online = isOnline,
                    info = if (isOnline) "Online verbunden" else "Offline-Modus aktiv"
                )
            }
        }
    }

    fun login(username: String, unlockCode: String, password: String, loginCode: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, loginError = "", info = "Anmeldung läuft...") }
            val payload = LoginPayload(
                username = username.trim(),
                unlockCode = unlockCode.trim(),
                password = password.trim().ifBlank { null },
                loginCode = loginCode.trim().ifBlank { null }
            )
            val result = api.login(payload)
            if (!result.ok || result.token.isNullOrBlank()) {
                _uiState.update {
                    it.copy(
                        loading = false,
                        loginError = result.error ?: "Anmeldung fehlgeschlagen",
                        info = "Login fehlgeschlagen"
                    )
                }
                return@launch
            }

            val session = AuthSession(
                token = result.token,
                username = username.trim(),
                unlockCode = unlockCode.trim(),
                userId = result.userId ?: "",
                offlineAllowed = true
            )
            store.save(session)
            _uiState.update {
                it.copy(
                    loading = false,
                    loggedIn = true,
                    username = result.username?.takeIf { value -> value.isNotBlank() } ?: username.trim(),
                    online = true,
                    info = "Angemeldet. Offline-Zugriff für lokale Tools aktiv."
                )
            }
        }
    }

    fun loginWithGoogle(idToken: String, unlockCode: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(loading = true, loginError = "", info = "Google-Anmeldung läuft...") }
            val result = api.loginWithGoogle(
                GoogleLoginPayload(
                    idToken = idToken.trim(),
                    unlockCode = unlockCode.trim()
                )
            )
            if (!result.ok || result.token.isNullOrBlank()) {
                _uiState.update {
                    it.copy(
                        loading = false,
                        loginError = result.error ?: "Google-Anmeldung fehlgeschlagen",
                        info = "Login fehlgeschlagen"
                    )
                }
                return@launch
            }

            val effectiveUsername = result.username?.takeIf { it.isNotBlank() } ?: "Google User"
            val session = AuthSession(
                token = result.token,
                username = effectiveUsername,
                unlockCode = unlockCode.trim(),
                userId = result.userId ?: "",
                offlineAllowed = true
            )
            store.save(session)
            _uiState.update {
                it.copy(
                    loading = false,
                    loggedIn = true,
                    username = effectiveUsername,
                    online = true,
                    info = "Mit Google angemeldet. Offline-Zugriff für lokale Tools aktiv."
                )
            }
        }
    }

    fun setLoginError(message: String) {
        _uiState.update { it.copy(loginError = message) }
    }

    fun logout() {
        viewModelScope.launch {
            store.clear()
            _uiState.value = AppUiState(loading = false)
        }
    }

    fun selectCategory(category: String) {
        val firstTool = tools.firstOrNull { it.category == category }
        _uiState.update {
            it.copy(
                selectedCategory = category,
                selectedToolId = firstTool?.id ?: it.selectedToolId,
                input1 = "",
                input2 = "",
                output = ""
            )
        }
    }

    fun selectTool(toolId: String) {
        _uiState.update { it.copy(selectedToolId = toolId, input1 = "", input2 = "", output = "") }
    }

    fun setInput1(value: String) {
        _uiState.update { it.copy(input1 = value) }
    }

    fun setInput2(value: String) {
        _uiState.update { it.copy(input2 = value) }
    }

    fun runTool() {
        val state = _uiState.value
        val tool = tools.firstOrNull { it.id == state.selectedToolId } ?: return
        val result = tool.run(state.input1, state.input2)
        _uiState.update { it.copy(output = result) }
    }
}
