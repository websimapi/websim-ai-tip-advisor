const BATCH_SIZE = 12;
let offset = 0;
let isLoading = false;
let hideGiveaways = true;
let currentRange = 'week';
let currentFeed = 'hot';

const projectsContainer = document.getElementById('projects-container');
const loader = document.getElementById('loader');

const systemPrompt = `
You are an AI expert at evaluating web projects and identifying hidden gems. Your task is to analyze a batch of projects and suggest fair tip amounts in credits, with special attention to helping new and upcoming creators.

You will receive project data including:
- Project stats (views, likes, comments)
- Creator metrics (total stats, averages per project, account age, project count, whether they're new)

IMPORTANT PRIORITIES:
1. IDENTIFY HIDDEN GEMS: Look for high-quality projects from new creators (account age < 30 days or < 5 projects) that deserve more attention
2. BOOST NEW CREATORS: New creators with promising work should get higher tip suggestions to encourage them
3. VALUE ENGAGEMENT QUALITY: Focus on like-to-view ratios and comment engagement rather than just raw numbers
4. REWARD CONSISTENCY: Creators with good average engagement per project show consistent quality

Tip Guidelines:
- Hidden gems from new creators: 50-500 credits (be generous to help them grow)
- High engagement projects regardless of creator: 100-400 credits
- Solid projects from established creators: 25-200 credits
- Lower engagement projects: 10-100 credits

Consider these factors:
- High like-to-view ratio (>5%) is excellent
- Good comment engagement shows community interaction
- New creators with any decent engagement deserve extra support
- Consistent creators (good avg stats per project) show reliability
- Balance helping newcomers while rewarding established quality

Respond ONLY with a single JSON object. The JSON object should have a single key "suggestions" which is an array of objects. Each object must follow this exact schema:
{
  "projectId": string,
  "suggestedTip": number, // 10-500 credits
  "reasoning": string, // Mention if it's a hidden gem or from a new creator deserving support
  "isHiddenGem": boolean // true if this is a promising project from a new creator
}
Do not include any other text, comments, or explanations outside of the JSON structure.
`;

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num;
}

async function getCreatorStatsForBatch(projects) {
    const creatorIds = [...new Set(projects.map(p => p.project.created_by.id).filter(id => id))];
    if (creatorIds.length === 0) return {};

    // Get both user stats and user profile data for more accurate assessment
    const statsPromises = creatorIds.map(async id => {
        try {
            const [statsRes, userRes, projectsRes] = await Promise.all([
                fetch(`/api/v1/users/${id}/stats`),
                fetch(`/api/v1/users/${id}`),
                fetch(`/api/v1/users/${id}/projects?first=100&has_revision=true`) // Get their projects to calculate averages
            ]);

            const stats = statsRes.ok ? await statsRes.json() : { stats: { total_likes: 0, total_views: 0 } };
            const user = userRes.ok ? await userRes.json() : null;
            const projects = projectsRes.ok ? await projectsRes.json() : { projects: { data: [] } };

            const projectCount = projects.projects?.data?.length || 0;
            const accountAge = user?.user?.created_at ? 
                Math.floor((Date.now() - new Date(user.user.created_at).getTime()) / (1000 * 60 * 60 * 24)) : 0;

            return {
                id,
                stats: stats.stats || { total_likes: 0, total_views: 0 },
                projectCount,
                accountAge,
                avgLikesPerProject: projectCount > 0 ? (stats.stats?.total_likes || 0) / projectCount : 0,
                avgViewsPerProject: projectCount > 0 ? (stats.stats?.total_views || 0) / projectCount : 0,
                isNewCreator: accountAge < 30 || projectCount < 5 // New if account < 30 days or < 5 projects
            };
        } catch (e) {
            console.error(`Failed to get comprehensive stats for user ${id}:`, e);
            return {
                id,
                stats: { total_likes: 0, total_views: 0 },
                projectCount: 0,
                accountAge: 0,
                avgLikesPerProject: 0,
                avgViewsPerProject: 0,
                isNewCreator: true
            };
        }
    });

    const results = await Promise.all(statsPromises);
    const creatorStatsMap = {};
    results.forEach(result => {
        if (result && result.id) {
            creatorStatsMap[result.id] = result;
        }
    });
    return creatorStatsMap;
}

async function getAiSuggestions(projectsData) {
    try {
        const completion = await websim.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: JSON.stringify({ projects: projectsData }) }
            ],
            json: true,
        });

        const result = JSON.parse(completion.content);
        return result.suggestions.reduce((acc, suggestion) => {
            acc[suggestion.projectId] = suggestion;
            return acc;
        }, {});
    } catch (error) {
        console.error("Error getting AI suggestions:", error);
        return {};
    }
}

function isGiveawayOrTipAskingSite(project) {
    const title = (project.title || '').toLowerCase();
    const description = (project.description || '').toLowerCase();
    
    const giveawayKeywords = [
        'giveaway', 'free credits', 'free tips', 'win credits', 'earn credits',
        'credit generator', 'free money', 'get rich', 'make money fast',
        'tip me', 'send tips', 'donate credits', 'support me with credits',
        'please tip', 'need credits', 'credit request', 'asking for tips',
        'help me with credits', 'fund my', 'crowdfund', 'donation'
    ];
    
    const text = title + ' ' + description;
    return giveawayKeywords.some(keyword => text.includes(keyword));
}

function renderProjects(projects, suggestions) {
    console.log('Rendering', projects.length, 'projects');
    
    projects.forEach((item) => {
        const { project } = item;
        
        // Skip giveaway/tip-asking sites if toggle is enabled
        if (hideGiveaways && isGiveawayOrTipAskingSite(project)) {
            console.log('Skipping giveaway/tip-asking site:', project.title);
            return;
        }
        
        const creator = project.created_by;
        const views = item.views || 0;
        const likes = item.likes || 0;
        const comments = item.comments || 0;
        const suggestion = suggestions[project.id] || { 
            suggestedTip: 25, 
            reasoning: 'Default suggestion - AI analysis unavailable.',
            isHiddenGem: false
        };
        
        console.log('Rendering project:', project.title, 'with suggestion:', suggestion);
        
        const card = document.createElement('div');
        card.className = 'project-card';
        
        // Add special styling for hidden gems
        if (suggestion.isHiddenGem) {
            card.classList.add('hidden-gem');
        }
        
        // Use project revision's site_id or fall back to a placeholder
        const thumbnailUrl = project.thumbnail?.url || 
                           (item.site?.id ? `https://images.websim.com/v1/site/${item.site.id}/600` : '') ||
                           (item.project_revision?.site_id ? `https://images.websim.com/v1/site/${item.project_revision.site_id}/600` : '');
        
        const projectUrl = `https://websim.com/p/${project.id}`;
        const creatorUrl = creator ? `https://websim.com/@${creator.username}`: '';

        const hiddenGemBadge = suggestion.isHiddenGem ? 
            '<span class="hidden-gem-badge">💎 Hidden Gem</span>' : '';

        card.innerHTML = `
            ${thumbnailUrl ? `<a href="${projectUrl}" target="_blank">
                <img src="${thumbnailUrl}" alt="${project.title || 'Project thumbnail'}" class="project-thumbnail" onerror="this.style.display='none'">
            </a>` : ''}
            <div class="card-content">
                <a href="${projectUrl}" target="_blank" class="project-title">${project.title || 'Untitled Project'}</a>
                ${hiddenGemBadge}
                ${creator ? `
                <div class="creator-info">
                    <a href="${creatorUrl}" target="_blank"><img src="https://images.websim.com/avatar/${creator.username}" alt="${creator.username}" class="creator-avatar"></a>
                    <a href="${creatorUrl}" target="_blank" class="creator-link">@${creator.username}</a>
                </div>` : ''}
                <div class="stats">
                    <div class="stat"><span class="stat-value">${formatNumber(views)}</span> Views</div>
                    <div class="stat"><span class="stat-value">${formatNumber(likes)}</span> Hearts</div>
                    <div class="stat"><span class="stat-value">${formatNumber(comments)}</span> Comments</div>
                </div>
                <div class="ai-suggestion">
                    <h3>💡 AI Tip Suggestion</h3>
                    <p>
                        <span class="tip-amount">${suggestion.suggestedTip} credits</span> - ${suggestion.reasoning}
                    </p>
                </div>
            </div>
        `;
        projectsContainer.appendChild(card);
    });
    
    console.log('Finished rendering projects. Total cards:', projectsContainer.children.length);
}

async function fetchAndDisplayProjects() {
    if (isLoading) return;
    isLoading = true;
    loader.style.display = 'block';

    try {
        const url = new URL(`${window.location.origin}/api/v1/feed/trending`);
        url.searchParams.set('limit', BATCH_SIZE);
        url.searchParams.set('offset', offset);
        url.searchParams.set('range', currentRange);
        url.searchParams.set('feed', currentFeed);
        
        console.log('Fetching from:', url.toString());
        
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Failed to fetch trending feed: ${res.statusText}`);
        }
        const response = await res.json();
        
        console.log('Raw response:', response);
        console.log('Projects in response:', response.feed?.data?.length);
        
        // Less restrictive filtering - only require project and created_by
        let projects = response.feed?.data?.filter(item => 
            item.project && 
            item.project.created_by && 
            item.project.id
        ) || [];
        
        // Additional filtering for giveaways if toggle is enabled
        if (hideGiveaways) {
            projects = projects.filter(item => !isGiveawayOrTipAskingSite(item.project));
        }
        
        console.log('Filtered projects:', projects.length);
        
        if (projects.length === 0) {
            const message = offset === 0 ? 
                'Could not find any projects. Please try again later.' : 
                'No more projects to display.';
            loader.innerHTML = `<p>${message}</p>`;
            loader.style.display = 'block';
            return;
        }

        console.log('Getting creator stats for', projects.length, 'projects');
        const creatorStats = await getCreatorStatsForBatch(projects);
        console.log('Creator stats:', creatorStats);

        const projectsDataForAI = projects.map(item => ({
            projectId: item.project.id,
            projectStats: {
                views: item.views || 0,
                likes: item.likes || 0,
                comments: item.comments || 0,
                likeToViewRatio: (item.views || 0) > 0 ? ((item.likes || 0) / (item.views || 0)) * 100 : 0
            },
            creatorData: creatorStats[item.project.created_by.id] || { 
                stats: { total_likes: 0, total_views: 0 },
                projectCount: 0,
                accountAge: 0,
                avgLikesPerProject: 0,
                avgViewsPerProject: 0,
                isNewCreator: true
            }
        }));
        
        console.log('Data for AI:', projectsDataForAI);
        
        const suggestions = await getAiSuggestions(projectsDataForAI);
        console.log('AI suggestions:', suggestions);
        
        renderProjects(projects, suggestions);
        
        offset += projects.length;
        loader.style.display = 'none';

    } catch (error) {
        console.error("Failed to fetch and display projects:", error);
        loader.innerHTML = '<p>Could not load projects. Please try again later.</p>';
        loader.style.display = 'block';
    } finally {
        isLoading = false;
    }
}

function handleInfiniteScroll() {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500 && !isLoading) {
        fetchAndDisplayProjects();
    }
}

function resetAndReload() {
    projectsContainer.innerHTML = '';
    offset = 0;
    fetchAndDisplayProjects();
}

// Toggle and filter event listeners
document.addEventListener('DOMContentLoaded', () => {
    const hideGiveawaysToggle = document.getElementById('hide-giveaways');
    const rangeFilter = document.getElementById('range-filter');
    const feedFilter = document.getElementById('feed-filter');
    
    hideGiveawaysToggle.addEventListener('change', (e) => {
        hideGiveaways = e.target.checked;
        resetAndReload();
    });
    
    rangeFilter.addEventListener('change', (e) => {
        currentRange = e.target.value;
        resetAndReload();
    });
    
    feedFilter.addEventListener('change', (e) => {
        currentFeed = e.target.value;
        resetAndReload();
    });
});

window.addEventListener('scroll', handleInfiniteScroll);
window.addEventListener('resize', handleInfiniteScroll);

// Initial load
fetchAndDisplayProjects();