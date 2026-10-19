// src/components/CommunityTab.tsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Download, RefreshCw, Info, Upload, AlertTriangle, Edit, Flag, Send, X, Trash2, Link } from 'lucide-react';
import { saveAgent, CompleteAgent, getAgentCode, getAgentMemory } from '@utils/agent_database';
import { Logger } from '@utils/logging';
import { useAuth } from '@contexts/AuthContext';
import EditAgentModal from '@components/EditAgent/EditAgentModal';
import PersonalInfoWarningModal from '@components/PersonalInfoWarningModal';
import { detectSensitiveFunctions, redactPassphrases } from '@utils/code_sanitizer';
import { isIOS, confirm } from '@utils/platform';
import { sendEmail } from '@utils/handlers/utils';


// Type for marketplace agents matching CompleteAgent structure
interface MarketplaceAgent {
  id: string;
  name: string;
  description: string;
  model_name: string;
  system_prompt: string;
  loop_interval_seconds: number;
  code: string;
  memory: string;
  author?: string;
  author_id?: string;
  date_added?: string;
  downloads?: number;
  featured_order?: number | null;
}

// Simple type for uploading agents
interface AgentUpload {
  id: string;
  name: string;
  description: string;
  model_name: string;
  system_prompt: string;
  loop_interval_seconds: number;
  code: string;
  memory: string;
  author: string;
  author_id: string;
  date_added: string;
}

const SPARKLE_DOTS = [
  { dx: '-28px', dy: '-32px', delay: '0ms',   color: '#f87171' },
  { dx:  '30px', dy: '-28px', delay: '40ms',  color: '#fb923c' },
  { dx: '-36px', dy:   '8px', delay: '60ms',  color: '#f87171' },
  { dx:  '38px', dy:  '10px', delay: '20ms',  color: '#fb923c' },
  { dx:  '-8px', dy:  '36px', delay: '80ms',  color: '#f87171' },
  { dx:  '10px', dy: '-40px', delay: '50ms',  color: '#fb923c' },
  { dx: '-42px', dy: '-10px', delay: '30ms',  color: '#f87171' },
  { dx:  '42px', dy: '-14px', delay: '70ms',  color: '#fb923c' },
];

const CopiedOverlay: React.FC = () => (
  <span style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    {/* sparkle dots — centered on the icon */}
    {SPARKLE_DOTS.map((d, i) => (
      <span
        key={i}
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: d.color,
          '--dx': d.dx,
          '--dy': d.dy,
          animation: `sparkle-fly 0.55s cubic-bezier(0.25,0.46,0.45,0.94) ${d.delay} forwards`,
        } as React.CSSProperties}
      />
    ))}
    {/* "Copied!" text */}
    <span
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        transform: 'translate(-20%, -90%) rotate(-6deg)',
        transformOrigin: 'bottom left',
        whiteSpace: 'nowrap',
        fontWeight: 700,
        fontSize: '0.75rem',
        color: '#1f2937',
        background: 'white',
        borderRadius: 6,
        padding: '2px 6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        animation: 'copied-pop-tl 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards',
        zIndex: 10,
      }}
    >
      Copied!
    </span>
  </span>
);

const CommunityTab: React.FC = () => {
  const { isAuthenticated: auth0IsAuthenticated, login, user: auth0User, isLoading, getAccessToken } = useAuth();
  const [agents, setAgents] = useState<MarketplaceAgent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<MarketplaceAgent | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [myAgents, setMyAgents] = useState<CompleteAgent[]>([]);
  const [selectedUploadAgent, setSelectedUploadAgent] = useState<string | null>(null);
  
  // New state for edit modal
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<MarketplaceAgent | null>(null);

  // State for personal info warning modal
  const [showPersonalInfoWarning, setShowPersonalInfoWarning] = useState(false);
  const [detectedFunctions, setDetectedFunctions] = useState<string[]>([]);
  const [warningLineNumbers, setWarningLineNumbers] = useState<Record<string, number[]>>({});
  const [warningCodePreview, setWarningCodePreview] = useState('');
  const [removedPassphraseCount, setRemovedPassphraseCount] = useState(0);
  const [removedPassphraseLines, setRemovedPassphraseLines] = useState<number[]>([]);
  const [pendingUpload, setPendingUpload] = useState<{
    type: 'existing' | 'file' | 'edit';
    agent: CompleteAgent;
    code: string;
    memory: string;
  } | null>(null);

  // State for report agent modal
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportingAgent, setReportingAgent] = useState<MarketplaceAgent | null>(null);
  const [reportComment, setReportComment] = useState('');
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [reportStatus, setReportStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // State for share link feedback
  const [copiedAgent, setCopiedAgent] = useState<string | null>(null);

  // File input ref for direct file uploads
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Server URL - update this to your Python backend address
  const SERVER_URL = 'https://api.observer-ai.com';

  // Improved auth state handling
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    // Check localStorage first (for cases where the auth state might not be immediately available)
    const storedAuthState = localStorage.getItem('auth_authenticated') === 'true';
    const storedUser = localStorage.getItem('auth_user');
    
    if (storedAuthState && storedUser) {
      setIsAuthenticated(true);
      setUser(JSON.parse(storedUser));
    }
    
    // Update with Auth0 state when available
    if (!isLoading) {
      if (auth0IsAuthenticated && auth0User) {
        setIsAuthenticated(true);
        setUser(auth0User);
        // Save auth state to localStorage
        localStorage.setItem('auth_authenticated', 'true');
        localStorage.setItem('auth_user', JSON.stringify(auth0User));
      } else if (!storedAuthState) {
        // Only reset if there's no stored auth state
        setIsAuthenticated(false);
        setUser(null);
      }
    }
  }, [auth0IsAuthenticated, auth0User, isLoading]);

  // Close modal on Escape key press
  useEffect(() => {
    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selectedAgent) {
        closeDetails();
      }
    };

    if (selectedAgent) {
      document.addEventListener('keydown', handleEscapeKey);
    }

    return () => {
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [selectedAgent]);

  const getToken = useCallback(async () => {
    if (isLoading || !auth0IsAuthenticated) {
      Logger.warn('AUTH', 'CommunityTab: getToken called but user not authenticated or auth is loading.');
      return undefined;
    }
    try {
      const token = await getAccessToken();
      return token;
    } catch (error) {
      Logger.error('AUTH', 'CommunityTab: Failed to retrieve access token.', error);
      throw error;
    }
  }, [auth0IsAuthenticated, isLoading, getAccessToken]);
  
  const fetchAgents = async () => {
    try {
      setIsLoadingAgents(true);
      setError(null);
      
      const response = await fetch(`${SERVER_URL}/agents`);

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const data = await response.json();
      setAgents(data);
      
      Logger.info('COMMUNITY', `Fetched ${data.length} agents from marketplace`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to fetch community agents: ${errorMessage}`);
      Logger.error('COMMUNITY', `Error fetching marketplace agents: ${errorMessage}`, err);
    } finally {
      setIsLoadingAgents(false);
    }
  };

  // Fetch local agents to allow for uploading
  const fetchMyAgents = async () => {
    try {
      const { listAgents } = await import('@utils/agent_database');
      const agents = await listAgents();
      setMyAgents(agents);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      Logger.error('COMMUNITY', `Error fetching local agents: ${errorMessage}`, err);
    }
  };

  useEffect(() => {
    fetchAgents();
  }, []);

  // Check if the current user is the author of an agent
  const isAuthorOfAgent = (agent: MarketplaceAgent): boolean => {
    if (!isAuthenticated || !user || !agent.author_id) return false;
    return user.sub === agent.author_id;
  };

  // Sort: user's own agents first, then featured, then rest
  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      const aOwned = isAuthenticated && user && a.author_id === user.sub ? 0 : 1;
      const bOwned = isAuthenticated && user && b.author_id === user.sub ? 0 : 1;
      if (aOwned !== bOwned) return aOwned - bOwned;
      const aFeatured = a.featured_order != null ? 0 : 1;
      const bFeatured = b.featured_order != null ? 0 : 1;
      return aFeatured - bFeatured;
    });
  }, [agents, isAuthenticated, user]);

  // Check for sensitive functions and passphrases in code; auto-strip passphrases
  // and show a warning/notice if anything was found or needs review
  const checkForSensitiveData = (
    code: string,
    agent: CompleteAgent,
    memory: string,
    uploadType: 'existing' | 'file' | 'edit'
  ): boolean => {
    // Whitelist passphrases are bearer codes — strip them automatically, no opt-out
    const passphraseResult = redactPassphrases(code);
    const sanitizedCode = passphraseResult.redactedCode;

    const detection = detectSensitiveFunctions(sanitizedCode);
    const hasPassphrases = passphraseResult.removedCount > 0;

    if (detection.hasSensitiveData || hasPassphrases) {
      // Store upload data for later (already sanitized of passphrases)
      setPendingUpload({
        type: uploadType,
        agent,
        code: sanitizedCode,
        memory
      });

      // Set warning modal data
      setDetectedFunctions(detection.detectedFunctions);
      setWarningLineNumbers(detection.lineNumbers);
      setWarningCodePreview(sanitizedCode);
      setRemovedPassphraseCount(passphraseResult.removedCount);
      setRemovedPassphraseLines(passphraseResult.lineNumbers);
      setShowPersonalInfoWarning(true);

      return true; // Sensitive data found or removed
    }

    return false; // Nothing found
  };

  // Handle warning modal cancel
  const handleWarningCancel = () => {
    setShowPersonalInfoWarning(false);
    setPendingUpload(null);
    setDetectedFunctions([]);
    setWarningLineNumbers({});
    setWarningCodePreview('');
    setRemovedPassphraseCount(0);
    setRemovedPassphraseLines([]);
  };

  // Handle warning modal "Edit Agent" button
  const handleWarningEditAgent = () => {
    if (!pendingUpload) return;

    // Close warning modal
    setShowPersonalInfoWarning(false);

    // Set up editing agent for EditAgentModal
    setEditingAgent({
      id: pendingUpload.agent.id,
      name: pendingUpload.agent.name,
      description: pendingUpload.agent.description,
      model_name: pendingUpload.agent.model_name,
      system_prompt: pendingUpload.agent.system_prompt,
      loop_interval_seconds: pendingUpload.agent.loop_interval_seconds,
      code: pendingUpload.code,
      memory: pendingUpload.memory
    });

    // Open edit modal
    setShowEditModal(true);
  };

  // Handle warning modal "Upload Anyway" button
  const handleWarningUploadAnyway = async () => {
    if (!pendingUpload) return;

    try {
      setShowPersonalInfoWarning(false);
      setIsUploading(true);

      // Proceed with upload based on type
      await completePendingUpload(pendingUpload);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to upload agent: ${errorMessage}`);
      Logger.error('COMMUNITY', `Error uploading agent: ${errorMessage}`, err);
    } finally {
      setPendingUpload(null);
      setDetectedFunctions([]);
      setWarningLineNumbers({});
      setWarningCodePreview('');
      setRemovedPassphraseCount(0);
      setRemovedPassphraseLines([]);
      setIsUploading(false);
    }
  };

  // Complete the pending upload after warning confirmation
  const completePendingUpload = async (upload: NonNullable<typeof pendingUpload>) => {
    const agentData: AgentUpload = {
      id: upload.agent.id,
      name: upload.agent.name,
      description: upload.agent.description,
      model_name: upload.agent.model_name,
      system_prompt: upload.agent.system_prompt,
      loop_interval_seconds: upload.agent.loop_interval_seconds,
      code: upload.code,
      memory: upload.memory,
      author: '', // Will be filled in uploadAgentToServer
      author_id: '', // Will be filled in uploadAgentToServer
      date_added: '' // Will be filled in uploadAgentToServer
    };

    await uploadAgentToServer(agentData);
  };

  // Fetch full agent details from the server
  const handleGetAgent = async (agentId: string): Promise<MarketplaceAgent | null> => {
    try {
      setError(null);
      Logger.info('COMMUNITY', `Fetching full agent details for ${agentId}`);

      const response = await fetch(`${SERVER_URL}/agents/${agentId}`);

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const fullAgent = await response.json();
      Logger.info('COMMUNITY', `Fetched full agent ${fullAgent.name} (downloads: ${fullAgent.downloads})`);

      return fullAgent;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to fetch agent details: ${errorMessage}`);
      Logger.error('COMMUNITY', `Error fetching agent: ${errorMessage}`, err);
      return null;
    }
  };

  // Import a full agent object to local database (no API call)
  const handleImport = async (agent: MarketplaceAgent) => {
    try {
      setError(null);
      setImporting(agent.id);
      Logger.info('COMMUNITY', `Importing agent ${agent.name} (${agent.id})`);

      // Prepare agent for local database using CompleteAgent structure
      const localAgent: CompleteAgent = {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        model_name: agent.model_name,
        system_prompt: agent.system_prompt,
        loop_interval_seconds: agent.loop_interval_seconds
      };

      // Save to local database
      await saveAgent(localAgent, agent.code);

      // Import memory if available
      if (agent.memory) {
        const { updateAgentMemory } = await import('@utils/agent_database');
        await updateAgentMemory(localAgent.id, agent.memory);
      }

      Logger.info('COMMUNITY', `Agent ${agent.name} imported successfully`);
      alert(`Agent "${agent.name}" imported successfully!`);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to import agent: ${errorMessage}`);
      Logger.error('COMMUNITY', `Error importing agent: ${errorMessage}`, err);
    } finally {
      setImporting(null);
    }
  };

  const viewDetails = async (agent: MarketplaceAgent) => {
    // Fetch full agent details from server (increments download counter)
    const fullAgent = await handleGetAgent(agent.id);
    if (fullAgent) {
      setSelectedAgent(fullAgent);
    }
  };

  const closeDetails = () => {
    setSelectedAgent(null);
  };

  const handleShare = async (agent: MarketplaceAgent) => {
    const url = `https://app.observer-ai.com/marketplace/${agent.id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const el = document.createElement('textarea');
      el.value = url;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopiedAgent(agent.id);
    setTimeout(() => setCopiedAgent(null), 2000);
  };

  // New function to handle edit button click
  const handleEditClick = (agent: MarketplaceAgent) => {
    if (!isAuthenticated) {
      login();
      return;
    }

    setEditingAgent(agent);
    setShowEditModal(true);
  };

  // Handle report button click
  const handleReportClick = (agent: MarketplaceAgent) => {
    if (!isAuthenticated) {
      login();
      return;
    }

    setReportingAgent(agent);
    setShowReportModal(true);
  };

  // Handle report submission
  const handleReportSubmit = async () => {
    if (!reportingAgent || !reportComment.trim() || !isAuthenticated) return;

    setIsSubmittingReport(true);
    setReportStatus('idle');

    try {
      const token = await getToken();
      if (!token) {
        throw new Error('Authentication failed. Could not retrieve token.');
      }

      const emailContent = `# Agent Report

## Reported Agent
- **Name:** ${reportingAgent.name}
- **ID:** ${reportingAgent.id}
- **Model:** ${reportingAgent.model_name}
${reportingAgent.author ? `- **Author:** ${reportingAgent.author}` : ''}

## Report Details
**Reason:**
${reportComment}

---

## Metadata
- **Timestamp:** ${new Date().toISOString()}
- **Reporter:** ${user?.email || 'Unknown'}
`;

      await sendEmail(emailContent, 'roymedina@me.com', token);

      setReportStatus('success');
      setTimeout(() => {
        setShowReportModal(false);
        setReportingAgent(null);
        setReportComment('');
        setReportStatus('idle');
      }, 2000);
    } catch (error) {
      console.error('Failed to send report email:', error);
      setReportStatus('error');
    } finally {
      setIsSubmittingReport(false);
    }
  };

  // Handle report modal close
  const handleReportClose = () => {
    if (!isSubmittingReport) {
      setShowReportModal(false);
      setTimeout(() => {
        setReportingAgent(null);
        setReportComment('');
        setReportStatus('idle');
      }, 300);
    }
  };

  // New function to handle saving edited agent
  const handleSaveEdit = async (completeAgent: CompleteAgent, code: string) => {
    try {
      setIsUploading(true);
      setError(null);

      if (!isAuthenticated || !user) {
        throw new Error('You must be logged in to edit agents');
      }

      if (!editingAgent) {
        throw new Error('No agent selected for editing');
      }

      // Get memory from the editing agent
      const memory = editingAgent.memory || '';

      // Check for sensitive data before uploading
      const hasSensitiveData = checkForSensitiveData(code, completeAgent, memory, 'edit');
      if (hasSensitiveData) {
        setIsUploading(false);
        setShowEditModal(false); // Close edit modal, warning modal will take over
        return; // Stop here, warning modal will handle next steps
      }

      // Prepare agent data for upload, maintaining original ID and author info
      const agentData: AgentUpload = {
        id: editingAgent.id,
        name: completeAgent.name,
        description: completeAgent.description,
        model_name: completeAgent.model_name,
        system_prompt: completeAgent.system_prompt,
        loop_interval_seconds: completeAgent.loop_interval_seconds,
        code,
        memory,
        // Keep original author information
        author: editingAgent.author || user.name || user.email || 'Anonymous User',
        author_id: editingAgent.author_id || user.sub || '',
        date_added: editingAgent.date_added || new Date().toISOString()
      };

      // Upload to server (will replace existing agent with same ID)
      await uploadAgentToServer(agentData);

      setEditingAgent(null);
      setShowEditModal(false);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to update agent: ${errorMessage}`);
      Logger.error('COMMUNITY', `Error updating agent: ${errorMessage}`, err);
    } finally {
      setIsUploading(false);
    }
  };

  const handleUploadClick = () => {
    if (!isAuthenticated) {
      login();
      return;
    }
    
    fetchMyAgents();
    setShowUploadModal(true);
  };

  const handleFileUploadClick = () => {
    if (!isAuthenticated) {
      login();
      return;
    }
    
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    try {
      setIsUploading(true);
      setError(null);

      if (!isAuthenticated) {
        throw new Error('You must be logged in to upload agents');
      }

      const file = files[0];
      const fileContent = await file.text();
      let agentData: Partial<AgentUpload>;

      // Try to parse as JSON first
      try {
        agentData = JSON.parse(fileContent);
      } catch (jsonError) {
        // If JSON fails, try YAML
        try {
          const { load } = await import('js-yaml');
          agentData = load(fileContent) as Partial<AgentUpload>;
        } catch (yamlError) {
          throw new Error('Invalid file format. Must be JSON or YAML.');
        }
      }

      // Validate the required fields
      if (!agentData.id || !agentData.name || !agentData.code) {
        throw new Error('Invalid agent file. Missing required fields (id, name, code).');
      }

      // Create CompleteAgent for checking
      const agent: CompleteAgent = {
        id: agentData.id,
        name: agentData.name,
        description: agentData.description || '',
        model_name: agentData.model_name || 'unknown',
        system_prompt: agentData.system_prompt || '',
        loop_interval_seconds: agentData.loop_interval_seconds || 10
      };

      const code = agentData.code;
      const memory = agentData.memory || '';

      // Check for sensitive data before uploading
      const hasSensitiveData = checkForSensitiveData(code, agent, memory, 'file');
      if (hasSensitiveData) {
        setIsUploading(false);
        return; // Stop here, warning modal will handle next steps
      }

      // Create a proper AgentUpload object with author info
      const fullAgentData: AgentUpload = {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        model_name: agent.model_name,
        system_prompt: agent.system_prompt,
        loop_interval_seconds: agent.loop_interval_seconds,
        code,
        memory,
        author: '', // Will be filled in uploadAgentToServer
        author_id: '', // Will be filled in uploadAgentToServer
        date_added: '' // Will be filled in uploadAgentToServer
      };

      // Send to server
      await uploadAgentToServer(fullAgentData);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to upload agent: ${errorMessage}`);
      Logger.error('COMMUNITY', `Error uploading agent: ${errorMessage}`, err);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const uploadAgentToServer = async (agentData: AgentUpload) => {
    try {
      // Make sure we have the author information
      if (!isAuthenticated || !user) {
        throw new Error('You must be logged in to upload agents');
      }
      
      // Add author information to the agent data if not already present
      const enrichedAgentData = {
        ...agentData,
        author: agentData.author || user.name || user.email || 'Anonymous User',
        author_id: agentData.author_id || user.sub || '',
        date_added: agentData.date_added || new Date().toISOString()
      };
      
      const token = await getToken();
      const response = await fetch(`${SERVER_URL}/agents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(enrichedAgentData)
      });
      
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      
      Logger.info('COMMUNITY', `Agent ${enrichedAgentData.name} uploaded successfully by ${enrichedAgentData.author}`);
      alert(`Agent "${enrichedAgentData.name}" uploaded successfully!`);
      
      // Refresh the agent list
      fetchAgents();
      setShowUploadModal(false);
    } catch (err) {
      throw err;
    }
  };

  const handleDeleteAgent = async (agent: MarketplaceAgent) => {
    if (!isAuthenticated || !user) {
      setError('You must be logged in to delete agents');
      return;
    }
    if (!await confirm(`Delete "${agent.name}" from the community marketplace? This cannot be undone.`)) {
      return;
    }
    try {
      setIsDeleting(agent.id);
      const token = await getToken();
      const response = await fetch(`${SERVER_URL}/agents/${agent.id}`, {
        method: 'DELETE',
        headers: {
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      Logger.info('COMMUNITY', `Agent ${agent.name} deleted from marketplace`);
      fetchAgents();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to delete agent: ${errorMessage}`);
      Logger.error('COMMUNITY', `Error deleting agent: ${errorMessage}`, err);
    } finally {
      setIsDeleting(null);
    }
  };

  const handleExistingAgentUpload = async () => {
    if (!selectedUploadAgent) {
      setError('Please select an agent to upload');
      return;
    }

    if (!isAuthenticated) {
      setError('You must be logged in to upload agents');
      return;
    }

    try {
      setIsUploading(true);
      setError(null);

      // Get agent details
      const agent = myAgents.find(a => a.id === selectedUploadAgent);
      if (!agent) {
        throw new Error('Selected agent not found');
      }

      // Get agent code and memory
      const code = await getAgentCode(agent.id);
      if (!code) {
        throw new Error('Agent code not found');
      }

      const memory = await getAgentMemory(agent.id);

      // Check for sensitive data before uploading
      const hasSensitiveData = checkForSensitiveData(code, agent, memory, 'existing');
      if (hasSensitiveData) {
        setIsUploading(false);
        return; // Stop here, warning modal will handle next steps
      }

      // Prepare agent data for upload with empty author fields
      // (they will be filled in by uploadAgentToServer)
      const agentData: AgentUpload = {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        model_name: agent.model_name,
        system_prompt: agent.system_prompt,
        loop_interval_seconds: agent.loop_interval_seconds,
        code,
        memory,
        author: '', // Will be filled in uploadAgentToServer
        author_id: '', // Will be filled in uploadAgentToServer
        date_added: '' // Will be filled in uploadAgentToServer
      };

      // Upload to server
      await uploadAgentToServer(agentData);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to upload agent: ${errorMessage}`);
      Logger.error('COMMUNITY', `Error uploading agent: ${errorMessage}`, err);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="mt-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold text-gray-900">Community Agents</h2>
        <div className="flex items-center space-x-2">
          <div className="flex items-center gap-1 mr-1">
            <a href="https://discord.gg/wnBb7ZQDUC" target="_blank" rel="noopener noreferrer" className="p-2 rounded-md hover:bg-gray-100 text-indigo-500" title="Discord">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.127 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" /></svg>
            </a>
            <a href="https://x.com/AppObserverAI" target="_blank" rel="noopener noreferrer" className="p-2 rounded-md hover:bg-gray-100 text-gray-700" title="X / Twitter">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.244H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
            </a>
            <a href="https://buymeacoffee.com/roy3838" target="_blank" rel="noopener noreferrer" className="p-2 rounded-md hover:bg-gray-100 text-yellow-600" title="Support the project">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" /></svg>
            </a>
            <a href="https://github.com/Roy3838/Observer" target="_blank" rel="noopener noreferrer" className="p-2 rounded-md hover:bg-gray-100 text-gray-700" title="GitHub">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-4 w-4"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" /></svg>
            </a>
          </div>
          <button
            onClick={fetchAgents}
            className="flex items-center space-x-2 px-3 py-2 rounded-full border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors text-sm font-medium"
            disabled={isLoadingAgents}
          >
            <RefreshCw className={`h-4 w-4 ${isLoadingAgents ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>

          <button
            onClick={handleUploadClick}
            className="flex items-center space-x-2 px-3 py-2 rounded-full bg-gray-900 text-white hover:bg-black transition-colors text-sm font-medium"
          >
            <Upload className="h-4 w-4" />
            <span>Upload Agent</span>
          </button>
        </div>
      </div>

      {!isAuthenticated && (
        <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-xl flex items-center">
          <AlertTriangle className="h-5 w-5 mr-2 text-gray-400 flex-shrink-0" />
          <p className="text-sm text-gray-600">
            You need to sign in to upload agents to the community.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl">
          {error}
        </div>
      )}

      {isLoadingAgents ? (
        <div className="text-center p-8">
          <div className="inline-block animate-spin mr-2">
            <RefreshCw className="h-6 w-6 text-gray-400" />
          </div>
          <span className="text-gray-500">Loading community agents...</span>
        </div>
      ) : agents.length === 0 ? (
        <div className="text-center p-8 bg-gray-50 rounded-xl border border-gray-200">
          <p className="text-gray-500">No community agents available</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sortedAgents.map(agent => (
            <div
              key={agent.id}
              className={`bg-white rounded-2xl border p-4 flex flex-col transition-shadow hover:shadow-sm ${
                agent.featured_order != null
                  ? 'border-amber-300 ring-1 ring-amber-200'
                  : 'border-gray-200'
              }`}
            >
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-gray-900">{agent.name}</h3>
                <div className="flex space-x-1">
                  <button
                    onClick={() => viewDetails(agent)}
                    className="p-2 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                    title="View details"
                  >
                    <Info className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => handleShare(agent)}
                    className="p-2 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors relative"
                    title="Copy share link"
                    style={{ overflow: 'visible' }}
                  >
                    <Link className="h-5 w-5" />
                    {copiedAgent === agent.id && <CopiedOverlay />}
                  </button>
                  {isAuthorOfAgent(agent) && (
                    <>
                      <button
                        onClick={() => handleEditClick(agent)}
                        className="p-2 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                        title="Edit your agent"
                      >
                        <Edit className="h-5 w-5" />
                      </button>
                      <button
                        onClick={() => handleDeleteAgent(agent)}
                        disabled={isDeleting === agent.id}
                        className="p-2 rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
                        title="Delete your agent"
                      >
                        <Trash2 className={`h-5 w-5 ${isDeleting === agent.id ? 'animate-pulse' : ''}`} />
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="flex-1">
                <div className="mb-4 flex flex-wrap gap-2">
                  {agent.featured_order != null && (
                    <span className="inline-block px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                      Featured
                    </span>
                  )}

                  <span className="inline-block px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                    Community
                  </span>

                  {isAuthorOfAgent(agent) && (
                    <span className="inline-block px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
                      Your Agent
                    </span>
                  )}
                </div>

                <div>
                  <p className="text-sm text-gray-500">
                    Model: {agent.model_name}
                  </p>
                  <p className="mt-2 text-sm text-gray-700">{agent.description}</p>
                  {agent.author && !isIOS() && (
                    <p className="mt-1 text-xs text-gray-400">
                      Contributed by: {agent.author}
                      {agent.date_added && (
                        <span> • {new Date(agent.date_added).toLocaleDateString()}</span>
                      )}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-auto pt-4 flex items-center space-x-3">
                <button
                  onClick={async () => {
                    const fullAgent = await handleGetAgent(agent.id);
                    if (fullAgent) {
                      await handleImport(fullAgent);
                    }
                  }}
                  className={`px-4 py-2 rounded-full flex items-center gap-2 text-sm font-medium transition-colors ${
                    importing === agent.id
                      ? 'bg-gray-300 text-gray-600'
                      : 'bg-gray-900 text-white hover:bg-black'
                  }`}
                >
                  <Download className={`h-4 w-4 ${importing === agent.id ? 'animate-pulse' : ''}`} />
                  {importing === agent.id ? 'Importing...' : 'Import'}
                </button>

                <div className="text-xs text-gray-500 bg-gray-100 px-2.5 py-1.5 rounded-full">
                  {agent.loop_interval_seconds}s
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input for agent upload */}
      <input 
        type="file"
        ref={fileInputRef}
        onChange={handleFileSelect}
        accept=".json,.yaml,.yml"
        className="hidden"
      />

      {/* Agent Details Modal */}
      {selectedAgent && createPortal(
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4"
          onClick={closeDetails}
        >
          <div
            className="bg-white rounded-lg shadow-lg w-full max-w-4xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center p-4 border-b flex-shrink-0">
              <h2 className="text-xl font-semibold truncate pr-4">{selectedAgent.name}</h2>
              <button onClick={closeDetails} className="p-2 rounded-full hover:bg-gray-100 flex-shrink-0">
                <X className="h-5 w-5" />
              </button>
            </div>
            
            <div className="flex-1 p-4 overflow-y-auto overflow-x-hidden min-h-0">
              <div className="mb-4">
                <h3 className="font-medium mb-2">Details</h3>
                <p className="break-words"><strong>ID:</strong> {selectedAgent.id}</p>
                <p><strong>Model:</strong> {selectedAgent.model_name}</p>
                <p><strong>Interval:</strong> {selectedAgent.loop_interval_seconds}s</p>
                <p className="break-words"><strong>Description:</strong> {selectedAgent.description}</p>
                
                {selectedAgent.author && !isIOS() && (
                  <div className="mt-2 p-2 bg-gray-50 rounded-lg text-sm">
                    <p><strong>Author:</strong> {selectedAgent.author}</p>
                    {selectedAgent.date_added && (
                      <p><strong>Added:</strong> {new Date(selectedAgent.date_added).toLocaleString()}</p>
                    )}
                  </div>
                )}
              </div>
              
              {selectedAgent.system_prompt && (
                <div className="mb-4">
                  <h3 className="font-medium mb-2">System Prompt</h3>
                  <div className="bg-gray-50 p-3 rounded overflow-auto max-h-40 text-sm font-mono">
                    {selectedAgent.system_prompt}
                  </div>
                </div>
              )}
              
              <div className="mb-4">
                <h3 className="font-medium mb-2">Agent Code</h3>
                <div className="bg-gray-50 p-3 rounded overflow-auto max-h-60 text-sm font-mono">
                  <pre>{selectedAgent.code}</pre>
                </div>
              </div>
            </div>
            
            <div className="p-4 border-t flex flex-col sm:flex-row justify-between gap-3 flex-shrink-0">
              <button
                onClick={() => {
                  handleReportClick(selectedAgent);
                }}
                className="px-4 py-3 sm:py-2 rounded-full border border-gray-200 text-red-600 hover:bg-red-50 flex items-center justify-center gap-2 order-last sm:order-first transition-colors"
              >
                <Flag className="h-4 w-4" />
                Report
              </button>
              <div className="flex flex-col sm:flex-row gap-3 sm:space-x-3">
                <button
                  onClick={() => handleShare(selectedAgent)}
                  className="px-4 py-3 sm:py-2 rounded-full border border-gray-200 text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2 transition-colors relative"
                  style={{ overflow: 'visible' }}
                >
                  <Link className="h-4 w-4" />
                  Share
                  {copiedAgent === selectedAgent.id && <CopiedOverlay />}
                </button>
                {isAuthorOfAgent(selectedAgent) && (
                  <button
                    onClick={() => {
                      handleEditClick(selectedAgent);
                      closeDetails();
                    }}
                    className="px-4 py-3 sm:py-2 rounded-full bg-green-600 text-white hover:bg-green-700 transition-colors"
                  >
                    Edit Agent
                  </button>
                )}
                <button
                  onClick={() => {
                    handleImport(selectedAgent);
                    closeDetails();
                  }}
                  className="px-4 py-3 sm:py-2 rounded-full bg-gray-900 text-white hover:bg-black transition-colors"
                >
                  Import Agent
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Upload Modal */}
      {showUploadModal && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-end sm:items-center justify-center z-[70] p-0 sm:p-4">
          <div className="bg-white rounded-t-2xl sm:rounded-xl shadow-xl w-full sm:w-auto sm:max-w-lg flex flex-col max-h-[92dvh] sm:max-h-[90vh]">
            {/* Header */}
            <div className="flex justify-between items-center px-5 py-4 border-b flex-shrink-0">
              <h2 className="text-lg font-semibold text-gray-900">Upload Agent</h2>
              <button
                onClick={() => setShowUploadModal(false)}
                className="p-1.5 rounded-full hover:bg-gray-100 text-gray-500 text-xl leading-none"
              >
                &times;
              </button>
            </div>

            {/* Scrollable body */}
            <div className="p-5 overflow-y-auto flex-1">
              <p className="mb-4 text-sm text-gray-600">
                Share one of your agents with the community marketplace so others can use it.
              </p>

              {/* Public sharing notice */}
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-5 text-sm text-amber-800">
                <strong>⚠️ Heads up:</strong> Your agent will be publicly visible to everyone on the marketplace.
              </div>

              {/* Select existing agent */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select an agent to upload
                </label>
                <select
                  value={selectedUploadAgent || ''}
                  onChange={(e) => setSelectedUploadAgent(e.target.value || null)}
                  className="w-full p-3 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <option value="">Choose an agent...</option>
                  {myAgents.map(agent => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-xs text-gray-400 font-medium">OR</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>

              {/* File upload */}
              <button
                onClick={handleFileUploadClick}
                className="w-full px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:border-gray-400 flex items-center justify-center gap-2 transition-colors"
              >
                <Upload className="h-4 w-4 flex-shrink-0" />
                Upload Agent File (.json or .yaml)
              </button>
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t flex flex-col-reverse sm:flex-row gap-3 sm:justify-end flex-shrink-0">
              <button
                onClick={() => setShowUploadModal(false)}
                className="w-full sm:w-auto px-5 py-2.5 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExistingAgentUpload}
                disabled={!selectedUploadAgent || isUploading}
                className={`w-full sm:w-auto px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                  !selectedUploadAgent
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : isUploading
                      ? 'bg-yellow-500 text-white'
                      : 'bg-blue-500 text-white hover:bg-blue-600'
                }`}
              >
                {isUploading ? 'Uploading...' : 'Upload Agent'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Edit Agent Modal */}
      {showEditModal && editingAgent && (
        <EditAgentModal
          isOpen={showEditModal}
          onClose={() => {
            setShowEditModal(false);
            setEditingAgent(null);
          }}
          createMode={false}
          agent={{
            id: editingAgent.id,
            name: editingAgent.name,
            description: editingAgent.description,
            model_name: editingAgent.model_name,
            system_prompt: editingAgent.system_prompt,
            loop_interval_seconds: editingAgent.loop_interval_seconds
          }}
          code={editingAgent.code}
          onSave={handleSaveEdit}
          getToken={getToken}
        />
      )}

      {/* Personal Info Warning Modal */}
      <PersonalInfoWarningModal
        isOpen={showPersonalInfoWarning}
        onClose={handleWarningCancel}
        detectedFunctions={detectedFunctions}
        codePreview={warningCodePreview}
        lineNumbers={warningLineNumbers}
        removedPassphraseCount={removedPassphraseCount}
        removedPassphraseLines={removedPassphraseLines}
        onCancel={handleWarningCancel}
        onEditAgent={handleWarningEditAgent}
        onUploadAnyway={handleWarningUploadAnyway}
      />

      {/* Report Agent Modal */}
      {showReportModal && reportingAgent && (
        <div
          className="fixed inset-0 bg-black/50 z-[80] flex items-center justify-center p-4"
          onClick={handleReportClose}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            {reportStatus === 'idle' && (
              <>
                <div className="flex justify-between items-center p-6 border-b border-gray-200">
                  <h2 className="text-xl font-semibold text-gray-800">Report Agent</h2>
                  <button
                    onClick={handleReportClose}
                    className="p-1 rounded-full text-gray-400 hover:bg-gray-100 transition"
                    disabled={isSubmittingReport}
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="p-6 space-y-4">
                  <div className="p-3 bg-gray-50 rounded-lg">
                    <p className="text-sm text-gray-600">
                      Reporting: <strong>{reportingAgent.name}</strong>
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Reason for report <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={reportComment}
                      onChange={(e) => setReportComment(e.target.value)}
                      placeholder="Please describe why you're reporting this agent..."
                      className="w-full p-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 transition resize-none"
                      rows={4}
                      disabled={isSubmittingReport}
                    />
                  </div>

                  <p className="text-xs text-gray-500">
                    Reports help keep the community safe. Please provide as much detail as possible.
                  </p>

                  <button
                    onClick={handleReportSubmit}
                    disabled={!reportComment.trim() || isSubmittingReport || !isAuthenticated}
                    className="w-full px-4 py-3 bg-red-600 text-white rounded-lg font-semibold text-sm flex items-center justify-center gap-2 hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
                  >
                    {isSubmittingReport ? 'Sending...' : 'Submit Report'}
                    <Send className="w-4 h-4" />
                  </button>

                  {!isAuthenticated && (
                    <p className="text-xs text-red-600 text-center flex items-center justify-center gap-1.5">
                      <AlertTriangle className="w-4 h-4" />
                      Please sign in to report agents.
                    </p>
                  )}
                </div>
              </>
            )}

            {reportStatus === 'success' && (
              <div className="p-8 text-center">
                <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg
                    className="w-8 h-8 text-green-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <p className="text-lg font-semibold text-gray-800">Report Submitted</p>
                <p className="text-sm text-gray-600 mt-1">Thank you for helping keep the community safe.</p>
              </div>
            )}

            {reportStatus === 'error' && (
              <div className="p-8 text-center">
                <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <AlertTriangle className="w-8 h-8 text-red-600" />
                </div>
                <p className="text-lg font-semibold text-gray-800">Oops!</p>
                <p className="text-sm text-gray-600 mt-1">Something went wrong. Please try again.</p>
                <button
                  onClick={() => setReportStatus('idle')}
                  className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700 transition"
                >
                  Try Again
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CommunityTab;
